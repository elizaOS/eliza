# 11376 — stale-base guard (final acceptance criterion)

Evidence for `.github/workflows/stale-base-guard.yml` +
`packages/scripts/stale-base-guard.mjs`: a required PR check that blocks the
PR #11271 failure mode (a PR tree carrying stale file contents so its squash
silently reverts work already merged on the target branch).

Every run below was produced by the committed script against the **real
repository history** (`node packages/scripts/stale-base-guard.mjs --repo . …`);
each `run-*.txt` holds the console output + `time` + exit code, each
`run-*.json` the machine-readable result.

## 1. The real #11271 topology — MUST FLAG (it does)

PR #11271: head `ae2024fa75`, squash `5b714c74e6`, base-at-merge
`5b714c74e6^` = `dc1a63b103`. Verified critical fact: **its merge-base was the
exact develop tip (0 commits, ~8 minutes behind)** — no base-age check could
ever have caught it; the reverts were inside the PR's own diff.

- `run-11271.{txt,json}` — base `5b714c74e6^`, head `ae2024fa75` (real PR
  head): **FAIL, 297 silent-revert findings** (218 modifications + 79
  deletions) out of #11271's 304 files, in **7.5 s** on the full local repo.
  Spot-checked flagged paths include every file named in #11376:
  `plugins/plugin-goals/src/services/checkin.ts(+.test.ts)`,
  `plugins/plugin-personal-assistant/.../subject-store.ts`,
  `.../inbound-reply-completion.ts`, `.github/workflows/lifeops-quality-bench.yml`,
  `packages/benchmarks/interrupt-bench/tests/honest-scoring.test.ts`,
  `plugins/plugin-scheduling/src/scheduled-task/due.ts`,
  `.github/workflows/test.yml`. The newest discarded commit reported for the
  LifeOps files is `cec0509416` (#11259) — exactly the work #11271 clobbered.
- `run-11271-squash.{txt,json}` — same run with the squash commit
  `5b714c74e6` as the head (identical tree): identical verdict, 297 findings.

## 2. The five #11271-restore merges — MUST PASS (they do)

Heal PRs restore newer content over a clobbered base; the guard's heal
detection must not flag them. Each run uses the PR's real head and the real
develop tip at its merge (`<mergeCommit>^`):

| run | PR | verdict |
| --- | --- | --- |
| `run-11427.*` | scheduler runtime re-land | pass, 0 findings |
| `run-11430.*` | goal check-in re-land | pass, 0 findings |
| `run-11433.*` | calendar runtime re-land | pass, 0 findings |
| `run-11490.*` | feed/benchmarks restore | pass, 0 findings |
| `run-11522.*` | homepage baselines restore | pass, 0 findings |

## 3. Live open-PR traffic — no false positives

`run-open-11571 / 11563 / 11561 / 11550 / 11530` — five open PRs (2026-07-02)
run against current `origin/develop`, including two more #11271 restores
(#11563 workflow re-add, #11530 lifeops-quality bench re-land): **all pass,
0 findings**.

`run-open2-11617 / 11613 / 11594 / 11550 / 11493` — a second, independent
sweep later the same day against develop tip `8be1bec002` with the then-open
PR set, deliberately including #11594 (a "restore … baseline" PR —
revert-shaped by name) and #11493 (the longest-open PR in the list): **all
pass, 0 findings**, sub-second per run.

## 4. Exact CI shape — blobless shallow clone, no lazy fetch

The workflow fetches `--filter=blob:none --depth=1500` and runs the detector
with `GIT_NO_LAZY_FETCH=1` (any accidental blob read would fail loudly).
Simulated byte-for-byte from GitHub into a fresh clone: fetch = **3.0 s /
15 MB**.

- `run-ci-shape-blobless.*` — open PR #11571 vs `origin/develop` inside that
  clone: pass in **0.44 s**, zero network.
- `run-ci-shape-blobless-finding.*` — a stale-revert head synthesized with
  pure plumbing (`update-index --cacheinfo` of the pre-#11565 blob of
  `wallet-signup.ts`, `commit-tree` on the develop tip) inside the same clone:
  **FAIL in 1.06 s**, zero network — the findings path (including commit
  metadata for the annotation) never needs blob contents.

## 5. Self-test

`self-test.txt` — `node packages/scripts/stale-base-guard.self-test.mjs`:
**9/9 fixture-repo scenarios pass** (clean edit, #11271 clobber shape,
heal PR, deletion-only notice, byte-identical re-add, commit/hour staleness
backstops + `--ack` override, `--window` bounding, missing merge-base). The
workflow runs this same self-test before the guard on every PR.

## 6. Independent re-verification (pre-PR, same day)

Every claim above was re-executed from scratch before opening the PR (a
different session than the one that produced the original runs):

- self-test: **9/9** pass.
- #11271 topology (`--base 5b714c74e6^ --head ae2024fa75`): **FAIL, 297
  findings in 8.1 s**; spot-checked `checkin.ts`, `subject-store.ts`,
  `lifeops-quality-bench.yml`, `test.yml` all flagged.
- all five restore merges (#11427/#11430/#11433/#11490/#11522, real head vs
  real `mergeCommit^`): **PASS, 0 findings**.
- fresh-clone CI shape from github.com (`--filter=blob:none --depth=1500`):
  fetch **2.4 s**, guard **0.17 s** PASS on open PR #11617; a plumbing-
  synthesized stale head (`read-tree` + `update-index --cacheinfo` pre-#11624
  blob of `packages/benchmarks/loadperf/boot-kpi.mjs` + `write-tree
  --missing-ok` + `commit-tree`) **FAILs in 0.35 s** with the correct
  discarded-commit annotation, `GIT_NO_LAZY_FETCH=1` throughout.
- the `run-open2-*` sweep in §3.

N/A — screenshots/video/audio/LLM trajectories: CI-only guard, no UI or model
surface; its observable behavior is the run outputs above.
