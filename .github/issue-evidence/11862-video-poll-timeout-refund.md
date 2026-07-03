# Issue #11862 — Video poll-timeout full-refund-while-upstream-bills (finding 1)

## Root cause

`POST /api/v1/generate-video` reserved credits, called `provider.generate()`,
and on ANY error fell into the catch's `reservation.reconcile(0)` — a full
refund. A poll timeout (Atlas' 180s loop in #11785, or any post-enqueue
transport failure on the merged fal path) is not a terminal verdict: the
upstream render can still complete and bill the platform. Result: the user is
fully refunded AND the platform pays the upstream invoice — a per-transaction
loss (~$2.25 for a 30s render at $0.075/s).

## Fix

- **Provider seam** (`packages/cloud/shared/src/lib/providers/video/types.ts`):
  `VideoGenerationPendingError` (job enqueued, terminal state unknowable) and a
  required `VideoProvider.getJobStatus()` that may only report `failed` on a
  definitive provider verdict — transport errors must throw so callers keep the
  hold. #11785's Atlas provider must implement it on rebase.
- **fal provider**: a post-enqueue failure probes `queue.status`/`queue.result`
  once — COMPLETED job is recovered in-request and charged normally; verified
  terminal failure (404 / completed-with-4xx-result) rethrows the original
  error so the route's refund stays; anything else throws the pending error.
  Also unwraps the `@fal-ai/client` v1 `Result` envelope (`{ data, requestId }`)
  in `normalizeFalVideoResult`.
- **Route**: on `VideoGenerationPendingError` the hold is NOT refunded; a
  pending generation row persists the settlement payload
  (`video_pending_settlement_v1` on `generations.metadata`: reservation tx id,
  reserved amount, billed cost, billing source; `job_id` = upstream request id)
  and the route answers 202. If even that persist fails, the hold is left for
  the #11493 stranded-reservation sweep (platform-safe) — never refunded blind.
- **Reconcile cron** (`/api/cron/reconcile-video-generations`, every minute):
  verifies the upstream terminal state per pending row — late success → the
  charge stands (settle at billed cost) and the generation completes with the
  delivered video; verified failure → refund exactly once (settled_at claim +
  `recon:<txid>:refund` key); verified-non-terminal past a 1h deadline → refund
  once (bounded); probe failure → nothing moves. The generic ~2h sweep remains
  the backstop and the settled_at claim makes the two writers race-safe.

## Fail-without-fix (route + fal provider reverted to origin/develop, new test kept)

```text
bun test __tests__/generate-video-timeout-pending.test.ts   # on develop's seam
(fail) poll timeout … > hold stays open, pending generation persisted …, 202
       expect(ledger.reconcileCalls).toBe(0)   — received 1 (full refund fired)
(fail) poll timeout … > persisting the pending generation fails: STILL no refund
(fail) in-request recovery … > probe finds COMPLETED: charged once …, 200
 2 pass  3 fail   (the 2 passes are the preserved refund-on-terminal-failure behaviors)
```

With the fix restored: `5 pass, 0 fail`.

## Real-PGlite money proofs (real reserve → real sweep → balances read from DB)

`packages/cloud/shared/src/lib/services/__tests__/video-generation-reconcile.test.ts`
— real `creditsService.reserve` (atomic CTE), real `generationsRepository`,
real `reconcilePendingVideoGenerations`; only the upstream status probe is
stubbed through the real registry API:

- timeout-then-success: charge stands (no refund row, balance stays debited),
  hold settled, generation completed with the delivered URL; second tick scans
  nothing and moves no money.
- timeout-then-failure: refunded exactly once; idempotent across a simulated
  crash-retry (row forced back to `pending`, second sweep adds no refund row).
- double-poll races (`Promise.all` of two sweeps), failure AND success verdicts:
  exactly one movement, `settled_at` claimed once, never a mint.
- deadline expiry: verified-non-terminal at 2h age refunds once and fails the row.
- probe failure: nothing moves even past the deadline — no blind refund.
- #11493 interplay: generic sweep settles first → video sweep's later refund is
  blocked by the settled_at claim (no second movement, no minted credit).

```text
bun test src/lib/services/__tests__/video-generation-reconcile.test.ts
=> 8 pass, 0 fail, 51 expect() calls
```

## Local verification (merge gate)

```text
packages/cloud/shared:
  bun test src/lib/providers/video/fal-video-generation.test.ts        => 15 pass, 0 fail
  bun test src/lib/services/__tests__/video-generation-reconcile.test.ts => 8 pass, 0 fail
  bun test src/lib/services/__tests__/credits-reconcile.test.ts        => 30 pass, 0 fail
  bunx tsc --noEmit -p tsconfig.json                                   => clean

packages/cloud/api (isolated, matching test/run-unit-isolated.mjs):
  generate-video-credit-leak      5 pass   generate-video-timeout-pending  5 pass
  generate-sfx-route              7 pass   chat-stream-credit-leak         6 pass
  embeddings-credit-leak          7 pass   credit-transactions-query      22 pass
  apps-chat-stream-refund         8 pass   apps-chat-nonstreaming-settle-guard 6 pass
  reclaim-stale-domains-cron      5 pass   — 0 fail across all
  bunx tsc --noEmit -p tsconfig.json                                   => clean
  bun run codegen                                                      => 633 mounted, 0 unconverted

biome check (11 touched files)                                         => clean
```

## UI / Media / Trajectories

- Screenshots / video walkthrough: N/A — backend cron/money-path fix; no
  user-facing UI surface changed (the 202 pending body is a new API shape on
  an existing endpoint, asserted in the route tests).
- Real-LLM trajectories: N/A — no agent/action/prompt/model behavior involved.
- Device capture: N/A — Cloudflare Worker code path only.
- Domain artifacts: the PGlite proofs read the produced artifacts directly
  from the DB (org `credit_balance`, reservation `settled_at`, refund
  transaction rows keyed `recon:<txid>:refund`, generation rows) and assert
  them to the cent; excerpts above.
