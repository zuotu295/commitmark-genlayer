# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""CommitMark: verified open-source contribution profiles.

A claim names a GitHub username and a repository. GenLayer validators
independently ask the public GitHub commits API whether that username
authored at least one commit in that repository, and must agree before
the claim is settled. A verified claim raises the username's profile
(count, score, badges, verified repos). A claim that finds no commit is
refuted and changes no profile.

Claims attest public contribution FACTS only. They do not prove that
the claimer owns the GitHub account named in the claim. Verification
reflects GitHub's own author attribution (commits whose author links
to the username).
"""

import json

from genlayer import *


def _badges_for(count: int) -> list:
    # Badges holds the single highest tier attained.
    if count >= 5:
        return ["Pillar"]
    if count >= 3:
        return ["Regular"]
    if count >= 1:
        return ["Contributor"]
    return []


class CommitMark(gl.Contract):
    next_id: u256
    claims: TreeMap[u256, str]
    claim_index: TreeMap[str, str]
    claimer_counts: TreeMap[str, u256]
    profiles: TreeMap[str, str]

    def __init__(self):
        self.next_id = u256(0)

    # -- validation helpers (deterministic) --------------------------------

    def _check_username(self, username: str) -> None:
        if len(username) < 1 or len(username) > 39:
            raise gl.vm.UserError("EXPECTED: username_length")
        if username[0] == "-" or username[-1] == "-":
            raise gl.vm.UserError("EXPECTED: username_format")
        for ch in username:
            ok = ("a" <= ch <= "z") or ("A" <= ch <= "Z") or ("0" <= ch <= "9") or ch == "-"
            if not ok:
                raise gl.vm.UserError("EXPECTED: username_format")

    def _check_repo(self, repo: str) -> None:
        parts = repo.split("/")
        if len(parts) != 2:
            raise gl.vm.UserError("EXPECTED: repo_format")
        for part in parts:
            if len(part) < 1:
                raise gl.vm.UserError("EXPECTED: repo_format")
            for ch in part:
                ok = (
                    ("a" <= ch <= "z")
                    or ("A" <= ch <= "Z")
                    or ("0" <= ch <= "9")
                    or ch == "."
                    or ch == "_"
                    or ch == "-"
                )
                if not ok:
                    raise gl.vm.UserError("EXPECTED: repo_format")

    def _index_get(self, key: str) -> str:
        # Missing keys either raise or read back as an empty default,
        # depending on host semantics; both mean "absent" here, and a
        # stored value is never the empty string.
        try:
            value = self.claim_index[key]
        except Exception:
            return ""
        return value if value else ""

    def _claimer_count(self, claimer: str) -> int:
        try:
            value = self.claimer_counts[claimer]
        except Exception:
            return 0
        return int(value)

    def _load(self, claim_id: u256) -> dict:
        try:
            raw = self.claims[claim_id]
        except Exception:
            raise gl.vm.UserError("EXPECTED: claim_not_found")
        if not raw:
            raise gl.vm.UserError("EXPECTED: claim_not_found")
        return json.loads(raw)

    def _profile_get(self, lower_name: str) -> dict:
        try:
            raw = self.profiles[lower_name]
        except Exception:
            raw = ""
        if not raw:
            return {
                "username": lower_name,
                "count": 0,
                "score": 0,
                "badges": [],
                "repos": [],
            }
        return json.loads(raw)

    # -- writes ------------------------------------------------------------

    @gl.public.write
    def claim_contribution(
        self, github_username: str, repo_full_name: str, note: str
    ) -> u256:
        username = github_username.strip()
        repo = repo_full_name.strip()
        note = note.strip()
        self._check_username(username)
        self._check_repo(repo)
        if len(note) < 2 or len(note) > 120:
            raise gl.vm.UserError("EXPECTED: note_length")
        claimer = str(gl.message.sender_address)
        if self._claimer_count(claimer) >= 32:
            raise gl.vm.UserError("EXPECTED: claim_cap_reached")
        key = username.lower() + "|" + repo.lower()
        if self._index_get(key) != "":
            raise gl.vm.UserError("EXPECTED: duplicate_claim")
        owner, name = repo.split("/")
        source_url = (
            "https://api.github.com/repos/"
            + owner
            + "/"
            + name
            + "/commits?author="
            + username
            + "&per_page=1"
        )
        nid = int(self.next_id)
        claim_id = u256(nid)
        self.next_id = u256(nid + 1)
        record = {
            "id": nid,
            "github_username": username,
            "repo_full_name": repo,
            "note": note,
            "claimer": claimer,
            "status": "pending",
            "source_url": source_url,
        }
        self.claims[claim_id] = json.dumps(record)
        self.claim_index[key] = str(nid)
        self.claimer_counts[claimer] = u256(self._claimer_count(claimer) + 1)
        return claim_id

    @gl.public.write
    def verify_contribution(self, claim_id: u256) -> str:
        record = self._load(claim_id)
        if record["status"] != "pending":
            raise gl.vm.UserError("EXPECTED: claim_not_pending")
        url = record["source_url"]

        def fetch_and_check() -> dict:
            response = gl.nondet.web.get(url)
            status = getattr(response, "status", 200)
            if status == 404:
                # Subject does not exist: no commit can be attributed.
                return {"present": False, "status": 404}
            if status != 200:
                raise gl.vm.UserError(f"EXTERNAL: github_status_{status}")
            body = response.body
            if isinstance(body, bytes):
                text = body.decode("utf-8")
            else:
                text = str(body)
            try:
                data = json.loads(text)
            except Exception:
                raise gl.vm.UserError("EXTERNAL: github_bad_json")
            if not isinstance(data, list):
                raise gl.vm.UserError("EXTERNAL: github_unexpected_shape")
            # The nondet result carries only a bool and an int: no
            # floats, so it stays calldata encodable.
            return {"present": len(data) > 0, "status": 200}

        def validate(leader_result) -> bool:
            if isinstance(leader_result, gl.vm.UserError):
                try:
                    fetch_and_check()
                except gl.vm.UserError:
                    return True
                except Exception:
                    return False
                return False
            if not isinstance(leader_result, gl.vm.Return):
                return False
            leader = leader_result.calldata
            if not isinstance(leader, dict):
                return False
            try:
                own = fetch_and_check()
            except Exception:
                return False
            if leader.get("present") != own["present"]:
                return False
            # Only 200 and 404 ever reach consensus, so comparing the
            # status is comparing the status class.
            if leader.get("status") != own["status"]:
                return False
            return True

        result = gl.vm.run_nondet_unsafe(fetch_and_check, validate)
        if result["present"]:
            record["status"] = "verified"
            lower_user = record["github_username"].lower()
            lower_repo = record["repo_full_name"].lower()
            profile = self._profile_get(lower_user)
            if lower_repo not in profile["repos"]:
                profile["repos"].append(lower_repo)
            profile["count"] = int(profile["count"]) + 1
            profile["score"] = profile["count"]
            profile["badges"] = _badges_for(profile["count"])
            self.profiles[lower_user] = json.dumps(profile)
        else:
            record["status"] = "refuted"
        self.claims[claim_id] = json.dumps(record)
        return json.dumps(record)

    # -- views -------------------------------------------------------------

    @gl.public.view
    def get_profile(self, username: str) -> str:
        return json.dumps(self._profile_get(username.strip().lower()))

    @gl.public.view
    def get_claim(self, claim_id: u256) -> str:
        return json.dumps(self._load(claim_id))

    @gl.public.view
    def get_claim_count(self) -> u256:
        return u256(int(self.next_id))

    @gl.public.view
    def list_claims(self, offset: u256, limit: u256) -> str:
        if limit < 1 or limit > 20:
            raise gl.vm.UserError("EXPECTED: limit_must_be_1_to_20")
        total = int(self.next_id)
        start = int(offset)
        if start >= total:
            return json.dumps([])
        end = start + int(limit)
        if end > total:
            end = total
        out = []
        index = start
        while index < end:
            out.append(self._load(u256(index)))
            index += 1
        return json.dumps(out)
