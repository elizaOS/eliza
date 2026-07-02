# Evidence — #11380 packages/feed browser-e2e de-larp (residual tail, PR #11567)

## Ground truth

Issue #11380 was filed against `4373bef34f`, which sits AFTER the #11271
stale-base squash — the "165 skip / 75 expect(true) / exit-0 gate" state it
describes was the clobbered state. The #11259 de-larp wave had already
remediated the bulk of it pre-clobber, and the restore PRs (#11438, #11490,
plus the #11531 zombie-file removal) re-landed that remediation on `develop`.
PR #11567 finishes the genuinely-unremediated residual.

## Before/after counts (`counts-before-after.txt`)

| metric (packages/feed) | issue-filed `4373bef34f` | PR base `d9d1a47ccd` | PR head |
| --- | --- | --- | --- |
| `expect(true).toBe(true)` | 79 | 4 | **0** |
| bare `test.skip();` (no reason) | 88 | 6 | **0** |
| skip/fixme markers in `*.spec.ts` | 165 (mostly silent) | 283 | **283 — all `test.skip(<condition>, "<reason>")`, zero bare** |
| HTTP `toBeLessThan(500)` over-tolerance | 24 | 27 | **2 — both non-HTTP (AMM share count, latency budget)** |

The marker count going UP from 165 → 283 is the point: silent green passes
became loud, counted, reasoned conditional skips (`skip-inventory.txt` lists
every one via `bun run test:skip-inventory`).

## What PR #11567 changed (residual tail only)

- Killed the last 4 silent-green `expect(true).toBe(true)` paths:
  `[EMBEDDING]` grounding tests are now provider-gated `test.skipIf` (loud
  counted skips without a real embedding provider; `requireEmbedding(...)`
  fails loud when a provider is configured but broken); the lookahead tick
  test asserts real before/after generation status.
- Gave every remaining bare `test.skip()` a visible reason string.
- Replaced 22 HTTP `toBeLessThan(500)` over-tolerances with exact expected
  statuses verified against the really-running local feed server (a 404 no
  longer counts as a pass).
- `moderation-e2e-verification` now asserts through the production
  `filterPostsByModeration` / `getFilteredUserIds` helpers instead of an
  inline re-implementation of the block filter.

## Files

- `counts-before-after.txt` — raw `git grep` counts at the three commits + shape audit of surviving markers.
- `gate-fail-without-fix.txt` — proof the `@feed/e2e` gate (restored in #11490) cannot silently green: CI-mode skip exits **3**, a wrapped failure exit code is **propagated verbatim** (exit 7 stays 7), success passes through, local non-strict skip is loud-bannered.
- `unit-lane-run.txt` — changed unit/optional-integration files: **60 pass / 7 explicit skips / 0 fail** (skips are the `[EMBEDDING]` provider gates, visibly counted).
- `integration-lane-run.txt` — the 7 changed integration files run through the real `test-integration-with-server.ts` harness (isolated workspace, real Next server on 127.0.0.1:3100, real Postgres on :5433, exact-status assertions).
- `browser-e2e-run.txt` — `RUN_FEED_E2E=1` run of the `@feed/e2e` Playwright lane through the gate (keyless localnet harness: anvil + contracts + app on :3000, real Chromium + MetaMask extension).
- `skip-inventory.txt` — `bun run test:skip-inventory` at PR head: every skip marker is `documented-inline` with a reason.

## Evidence-type coverage per PR_EVIDENCE.md

- Real runs + logs: attached above (structured `[ClassName]` backend logs are inside `integration-lane-run.txt`).
- Fail-without-fix proof: `gate-fail-without-fix.txt`.
- Video walkthrough / before-after UI screenshots: **N/A — test-only change; no user-visible UI surface was modified.**
- Real-LLM trajectories: **N/A — no agent/action/provider/prompt/model behavior change; embedding-gated tests skip loudly when no real provider is configured.**
- Audio walkthrough: **N/A — no voice/TTS/STT surface touched.**
