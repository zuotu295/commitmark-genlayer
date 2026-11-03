# CommitMark

🌐 **Live site:** https://zuotu295.github.io/commitmark-genlayer/
🔗 **Contract (Stable Studionet):** https://explorer-studio.genlayer.com/address/0x32D95f9BAe69488aB5793eaA985305218F3761A7

**Verified open-source contribution profiles, settled by consensus.**

CommitMark turns a GitHub contribution claim into a verified on-chain
profile. Claim that a username authored commits in a repository, and
GenLayer validators independently ask the public GitHub commits API
whether that is true. Only when they agree does the claim settle —
`verified` raises the profile (count, score, badges, verified repos),
`refuted` changes nothing. A screenshot of a commit list proves
nothing — anyone can edit it. This profile cannot be invented by one
party alone.

## How it works

1. `claim_contribution` (deterministic) stores the GitHub username,
   repository (`owner/repo`), note, and the exact GitHub commits API
   URL to be fetched. Usernames, repository formats, and note lengths
   are validated here, before any web work. Each claimer may hold at
   most 32 claims, and the same (username, repository) pair may only
   be claimed once.
2. `verify_contribution` (non-deterministic) runs on the leader and
   on every validator. Each one fetches that URL and derives one
   answer: present or not, with the API status. A validator accepts
   the leader result only if it independently reproduced it — same
   present value, same status class. Checking only the shape of the
   leader output would not be consensus, so the contract never does
   that.
3. Only after agreement is the claim settled. A failed fetch writes
   nothing, so the claim stays `pending` and can be retried. A
   settled claim can never be overwritten.
4. Profiles accumulate verified claims only. Badges hold the single
   highest tier attained: `Contributor` at 1, `Regular` at 3,
   `Pillar` at 5. Score equals verified count. Unknown names read
   back as zero counts and empty badges/repos, never as errors.

See [`docs/consensus.md`](docs/consensus.md) for the full agreement
rules, failure modes, caps, and scope.

## Network — Stable Studionet only

| Item | Value |
| --- | --- |
| Network | Stable Studionet |
| Chain ID | 61999 |
| RPC | https://studio.genlayer.com/api |
| Explorer | https://explorer-studio.genlayer.com |
| Cost | 0 GEN on Studionet (gasless); no API key, no server, no purchases |

No other network is used. Do not point this project at another chain.

## Contract

- Source: [`contracts/commitmark.py`](contracts/commitmark.py)
- Deployed address, deploy tx and evidence: see
  [`deployment.json`](deployment.json) and
  [`evidence.json`](evidence.json).
- Studio: `https://studio.genlayer.com/?import-contract=0x32D95f9BAe69488aB5793eaA985305218F3761A7`

## Usage

Run the tests (plain Python, no GenVM needed):

```sh
python3 tests/test_commitmark.py
```

Deploy to Studionet (an ephemeral key is used when
`GENLAYER_PRIVATE_KEY` is not set; keys are never written to disk):

```sh
npm install
npm run deploy
```

Run the on-chain loop (claim + verify a real contribution and a
non-contribution, read both profiles back, write `evidence.json`):

```sh
npm run flow
```

Re-check the recorded evidence against the chain:

```sh
npm run verify
```

## Scope notes

- Claims attest public contribution **facts** only. They do not prove
  that the claimer owns the GitHub account named in the claim.
- Verification reflects GitHub's own author attribution (commits
  whose author links to the username) at fetch time. Settled claims
  do not rewrite themselves if GitHub's data changes later.
- The public GitHub API is rate-limited without authentication.
  CommitMark is designed for demo scale.
