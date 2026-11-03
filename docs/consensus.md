# Consensus design

## What a claim is

A claim names a GitHub username, a repository (`owner/repo`), and a
short note. It is a question, not a proof: "did this username author
at least one commit in this repository?" The contract answers it from
the public GitHub commits API, by consensus, and only then settles the
claim as `verified` or `refuted`.

## What validators agree on

`verify_contribution` fetches one deterministic URL, built when the
claim was created:

```
https://api.github.com/repos/{owner}/{repo}/commits?author={username}&per_page=1
```

The nondet result carries only two fields, both calldata encodable:
`present` (bool) and `status` (int). No floats travel through
consensus; numbers are carried as ints or strings and converted only
after agreement.

| API outcome | Agreed result |
| --- | --- |
| 200 with a non-empty commits array | `present: true, status: 200` |
| 200 with an empty array | `present: false, status: 200` |
| 404 | `present: false, status: 404` |
| Any other status, bad JSON, unexpected shape, or fetch exception | `UserError` (fail-closed, see below) |

A validator accepts the leader result only if it independently
re-fetches the same URL and reproduces both fields: the same
`present` value and the same status (only 200 and 404 ever reach
consensus, so comparing the status is comparing the status class).
Checking only the shape of the leader output would not be consensus,
so the contract never does that.

## What happens after agreement

- `present: true` → the claim becomes `verified`, and the profile for
  the lowercased username is updated: count +1, the lowercased
  repository added to its verified repos, score set to count, and
  badges recomputed.
- `present: false` → the claim becomes `refuted`. No profile changes.

## Badges

Badges holds the single highest tier attained:

| Verified count | Badge |
| --- | --- |
| 1–2 | `Contributor` |
| 3–4 | `Regular` |
| 5+ | `Pillar` |

## Failure modes (fail-closed)

- **Fetch failure or unexpected API response**: the leader raises
  `UserError` before any write. A validator that also fails with a
  `UserError` agrees with that outcome; a validator that succeeds
  does not. The claim stays `pending` and can be retried.
- **Validator disagreement**: no state changes. The transaction does
  not silently store the leader's answer.
- **Already settled**: verifying a non-pending claim is rejected
  deterministically (`EXPECTED: claim_not_pending`), so a settled
  claim is never overwritten.
- **Bad input**: username, repository format, and note length are
  validated deterministically in `claim_contribution`, before any
  web work. Usernames are 1–39 characters of letters, digits, and
  hyphens, not starting or ending with a hyphen. Repository names
  are `owner/repo` with each part using letters, digits, `.`, `_`,
  or `-`. Notes are 2–120 characters.
- **Caps and duplicates**: each claimer may hold at most 32 claims.
  The same (lowercased username, lowercased repository) pair may
  only be claimed once, in any status, by anyone. Both violations
  are deterministic `EXPECTED` errors.

## Scope: what verification does and does not prove

- A verified claim proves that GitHub's own author attribution links
  at least one commit in the repository to the username, as agreed
  by independent validators. It does **not** prove that the claimer
  owns the GitHub account named in the claim.
- Verification reflects GitHub's author attribution at fetch time.
  If GitHub's data changes later, settled claims do not rewrite
  themselves.
- The public GitHub API is rate-limited without authentication.
  CommitMark is designed for demo scale; a production deployment
  would need authenticated API access or a caching layer.
- Profiles are keyed by lowercased username. Scores equal verified
  counts. Unknown names read back as zero counts and empty
  badges/repos, never as errors.
