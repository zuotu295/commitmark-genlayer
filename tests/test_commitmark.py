"""Tests for contracts/commitmark.py (claims, verify, profiles).

Runs with plain python3 (no pytest, no GenVM). A minimal `genlayer`
stub is injected into sys.modules before the contract is imported: it
provides the host surface the contract uses (gl.Contract, gl.public
decorators, gl.vm.UserError/Return/run_nondet_unsafe, gl.nondet.web.get,
gl.message.sender_address, TreeMap, u256). The stub's
run_nondet_unsafe mirrors consensus honestly: the fetch runs once for
the leader, then validate() re-fetches for the validator; agreement
returns the result, disagreement or a shared fetch failure raises
(fail-closed, state unchanged). A non-UserError leader exception
propagates without consensus, also without state change.
"""

import importlib.util
import json
import sys
import types
import unittest


class UserError(Exception):
    pass


class Return:
    def __init__(self, calldata):
        self.calldata = calldata


class TreeMap(dict):
    def __class_getitem__(cls, item):
        return cls


class MockResponse:
    def __init__(self, status, body):
        self.status = status
        self.body = body


class MockWeb:
    def __init__(self):
        self.queue = []
        self.last = None
        self.urls = []

    def set(self, items):
        self.queue = list(items)
        self.last = None
        self.urls = []

    def get(self, url):
        self.urls.append(url)
        if self.queue:
            item = self.queue.pop(0)
            self.last = item
        else:
            item = self.last
        if isinstance(item, Exception):
            raise item
        return item


def run_nondet_unsafe(fetch, validate):
    try:
        leader_wrapped = Return(fetch())
    except UserError as e:
        leader_wrapped = e
    except Exception:
        raise
    ok = validate(leader_wrapped)
    if not ok:
        raise Exception("consensus disagreement")
    if isinstance(leader_wrapped, UserError):
        raise leader_wrapped
    return leader_wrapped.calldata


def _identity_decorator(fn):
    return fn


class _Public:
    write = staticmethod(_identity_decorator)
    view = staticmethod(_identity_decorator)


class _Vm:
    UserError = UserError
    Return = Return
    run_nondet_unsafe = staticmethod(run_nondet_unsafe)


class _Message:
    sender_address = "0xTESTCLAIMER"


class _Nondet:
    def __init__(self, web):
        self.web = web


class _Gl:
    Contract = object
    public = _Public()
    vm = _Vm()
    message = _Message()

    def __init__(self, web):
        self.nondet = _Nondet(web)


WEB = MockWeb()
GL = _Gl(WEB)

genlayer_stub = types.ModuleType("genlayer")
genlayer_stub.gl = GL
genlayer_stub.u256 = int
genlayer_stub.TreeMap = TreeMap
sys.modules["genlayer"] = genlayer_stub

spec = importlib.util.spec_from_file_location(
    "commitmark", "contracts/commitmark.py"
)
commitmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(commitmark)
CommitMark = commitmark.CommitMark


def fresh():
    c = CommitMark()
    c.claims = TreeMap()
    c.claim_index = TreeMap()
    c.claimer_counts = TreeMap()
    c.profiles = TreeMap()
    return c


def commits_response():
    return MockResponse(200, json.dumps([{"sha": "abc123"}]))


def empty_response():
    return MockResponse(200, "[]")


def not_found_response():
    return MockResponse(404, '{"message":"Not Found"}')


def status_response(status):
    return MockResponse(status, "")


def claim(c, user, repo, note="demo note"):
    return c.claim_contribution(user, repo, note)


class TestValidation(unittest.TestCase):
    def setUp(self):
        GL.message.sender_address = "0xTESTCLAIMER"
        self.c = fresh()

    def test_bad_usernames(self):
        for bad in ["", "a" * 40, "-abc", "abc-", "user_name", "user name", "user@x"]:
            with self.assertRaises(UserError, msg=bad):
                claim(self.c, bad, "owner/repo")

    def test_good_username_edges(self):
        self.assertEqual(claim(self.c, "a", "o/r"), 0)
        self.assertEqual(claim(self.c, "a" * 39, "o/r2"), 1)
        self.assertEqual(claim(self.c, "user-name-1", "o/r3"), 2)

    def test_bad_repos(self):
        for bad in ["noslash", "a/b/c", "/repo", "owner/", "own er/repo", "owner/re@po"]:
            with self.assertRaises(UserError, msg=bad):
                claim(self.c, "someuser", bad)

    def test_good_repo_chars(self):
        self.assertEqual(claim(self.c, "u", "my.org/my_repo-1"), 0)

    def test_note_length(self):
        with self.assertRaises(UserError):
            claim(self.c, "u", "o/r", "x")
        with self.assertRaises(UserError):
            claim(self.c, "u", "o/r", "x" * 121)
        self.assertEqual(claim(self.c, "u", "o/r", "ok"), 0)

    def test_cap(self):
        for i in range(32):
            claim(self.c, f"user{i}", f"owner/repo{i}")
        with self.assertRaises(UserError):
            claim(self.c, "user32", "owner/repo32")

    def test_cap_is_per_claimer(self):
        for i in range(32):
            claim(self.c, f"user{i}", f"owner/repo{i}")
        GL.message.sender_address = "0xOTHERCLAIMER"
        self.assertEqual(claim(self.c, "user32", "owner/repo32"), 32)

    def test_duplicate_global_and_case_insensitive(self):
        claim(self.c, "Alice", "Owner/Repo")
        with self.assertRaises(UserError):
            claim(self.c, "alice", "owner/repo")
        with self.assertRaises(UserError):
            claim(self.c, "ALICE", "OWNER/REPO")
        GL.message.sender_address = "0xOTHERCLAIMER"
        with self.assertRaises(UserError):
            claim(self.c, "alice", "owner/repo")
        self.assertEqual(claim(self.c, "alice", "owner/other"), 1)
        self.assertEqual(claim(self.c, "bob", "owner/repo"), 2)

    def test_source_url(self):
        claim(self.c, "torvalds", "torvalds/linux")
        record = json.loads(self.c.get_claim(0))
        self.assertEqual(
            record["source_url"],
            "https://api.github.com/repos/torvalds/linux/commits?author=torvalds&per_page=1",
        )
        self.assertEqual(record["status"], "pending")
        self.assertEqual(record["claimer"], "0xTESTCLAIMER")


class TestVerify(unittest.TestCase):
    def setUp(self):
        GL.message.sender_address = "0xTESTCLAIMER"
        self.c = fresh()

    def test_verify_present(self):
        claim(self.c, "torvalds", "torvalds/linux")
        WEB.set([commits_response(), commits_response()])
        out = json.loads(self.c.verify_contribution(0))
        self.assertEqual(out["status"], "verified")
        profile = json.loads(self.c.get_profile("torvalds"))
        self.assertEqual(profile["count"], 1)
        self.assertEqual(profile["score"], 1)
        self.assertEqual(profile["badges"], ["Contributor"])
        self.assertEqual(profile["repos"], ["torvalds/linux"])

    def test_verify_absent(self):
        claim(self.c, "someone", "owner/repo")
        WEB.set([empty_response(), empty_response()])
        out = json.loads(self.c.verify_contribution(0))
        self.assertEqual(out["status"], "refuted")
        profile = json.loads(self.c.get_profile("someone"))
        self.assertEqual(profile["count"], 0)
        self.assertEqual(profile["repos"], [])

    def test_verify_404(self):
        claim(self.c, "someone", "nope/nothing")
        WEB.set([not_found_response(), not_found_response()])
        out = json.loads(self.c.verify_contribution(0))
        self.assertEqual(out["status"], "refuted")
        self.assertEqual(json.loads(self.c.get_profile("someone"))["count"], 0)

    def test_fail_closed_then_retry(self):
        claim(self.c, "torvalds", "torvalds/linux")
        WEB.set([status_response(403), status_response(403)])
        with self.assertRaises(UserError):
            self.c.verify_contribution(0)
        self.assertEqual(json.loads(self.c.get_claim(0))["status"], "pending")
        WEB.set([commits_response(), commits_response()])
        out = json.loads(self.c.verify_contribution(0))
        self.assertEqual(out["status"], "verified")

    def test_fetch_exception_fail_closed(self):
        claim(self.c, "torvalds", "torvalds/linux")
        WEB.set([RuntimeError("network down"), RuntimeError("network down")])
        with self.assertRaises(Exception):
            self.c.verify_contribution(0)
        self.assertEqual(json.loads(self.c.get_claim(0))["status"], "pending")

    def test_disagreement_present_vs_absent(self):
        claim(self.c, "torvalds", "torvalds/linux")
        WEB.set([commits_response(), empty_response()])
        with self.assertRaises(Exception):
            self.c.verify_contribution(0)
        self.assertEqual(json.loads(self.c.get_claim(0))["status"], "pending")

    def test_disagreement_status_class(self):
        claim(self.c, "someone", "owner/repo")
        WEB.set([empty_response(), not_found_response()])
        with self.assertRaises(Exception):
            self.c.verify_contribution(0)
        self.assertEqual(json.loads(self.c.get_claim(0))["status"], "pending")

    def test_verify_twice_rejected(self):
        claim(self.c, "torvalds", "torvalds/linux")
        WEB.set([commits_response(), commits_response()])
        self.c.verify_contribution(0)
        with self.assertRaises(UserError):
            self.c.verify_contribution(0)

    def test_claim_not_found(self):
        with self.assertRaises(UserError):
            self.c.get_claim(999)
        with self.assertRaises(UserError):
            self.c.verify_contribution(999)


class TestProfiles(unittest.TestCase):
    def setUp(self):
        GL.message.sender_address = "0xTESTCLAIMER"
        self.c = fresh()

    def verify_repo(self, user, repo):
        claim(self.c, user, repo)
        cid = self.c.get_claim_count() - 1
        WEB.set([commits_response(), commits_response()])
        self.c.verify_contribution(cid)

    def test_badge_thresholds(self):
        self.verify_repo("dev", "o/r1")
        self.assertEqual(json.loads(self.c.get_profile("dev"))["badges"], ["Contributor"])
        self.verify_repo("dev", "o/r2")
        self.assertEqual(json.loads(self.c.get_profile("dev"))["badges"], ["Contributor"])
        self.verify_repo("dev", "o/r3")
        self.assertEqual(json.loads(self.c.get_profile("dev"))["badges"], ["Regular"])
        self.verify_repo("dev", "o/r4")
        self.assertEqual(json.loads(self.c.get_profile("dev"))["badges"], ["Regular"])
        self.verify_repo("dev", "o/r5")
        profile = json.loads(self.c.get_profile("dev"))
        self.assertEqual(profile["badges"], ["Pillar"])
        self.assertEqual(profile["count"], 5)
        self.assertEqual(profile["score"], 5)
        self.assertEqual(
            profile["repos"], ["o/r1", "o/r2", "o/r3", "o/r4", "o/r5"]
        )

    def test_accumulation_and_refuted_no_change(self):
        self.verify_repo("dev", "o/good1")
        claim(self.c, "dev", "o/bad")
        WEB.set([empty_response(), empty_response()])
        self.c.verify_contribution(1)
        profile = json.loads(self.c.get_profile("dev"))
        self.assertEqual(profile["count"], 1)
        self.assertEqual(profile["repos"], ["o/good1"])
        self.verify_repo("dev", "o/good2")
        profile = json.loads(self.c.get_profile("dev"))
        self.assertEqual(profile["count"], 2)
        self.assertEqual(profile["repos"], ["o/good1", "o/good2"])
        self.assertEqual(profile["badges"], ["Contributor"])

    def test_profile_unknown(self):
        profile = json.loads(self.c.get_profile("nobody-here"))
        self.assertEqual(profile["username"], "nobody-here")
        self.assertEqual(profile["count"], 0)
        self.assertEqual(profile["score"], 0)
        self.assertEqual(profile["badges"], [])
        self.assertEqual(profile["repos"], [])

    def test_profile_lookup_case_insensitive(self):
        self.verify_repo("Dev", "o/r1")
        profile = json.loads(self.c.get_profile("DEV"))
        self.assertEqual(profile["count"], 1)
        self.assertEqual(profile["username"], "dev")

    def test_list_pagination_and_count(self):
        for i in range(3):
            claim(self.c, f"u{i}", f"o/r{i}")
        self.assertEqual(self.c.get_claim_count(), 3)
        page = json.loads(self.c.list_claims(0, 20))
        self.assertEqual([r["id"] for r in page], [0, 1, 2])
        page = json.loads(self.c.list_claims(1, 1))
        self.assertEqual([r["id"] for r in page], [1])
        self.assertEqual(json.loads(self.c.list_claims(5, 20)), [])
        with self.assertRaises(UserError):
            self.c.list_claims(0, 0)
        with self.assertRaises(UserError):
            self.c.list_claims(0, 21)


if __name__ == "__main__":
    unittest.main()
