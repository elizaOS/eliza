# Issue #10628 evidence: payout retry exhaustion

## Scope

- Issue: https://github.com/elizaOS/eliza/issues/10628
- Fix scope: confirmed stuck redemption path where a retryable pre-broadcast payout failure reaches `MAX_RETRY_ATTEMPTS`.
- Out of scope: Solana nonce fencing/recovery design call from the issue body. This PR does not change Solana nonce semantics.

## Root cause

`PayoutProcessorService.markFailed(..., retryable=true)` always reset the row to `approved` and incremented `retry_count`. With the default max of 3 attempts, a redemption could become:

```text
status = approved
retry_count = 3
```

`processBatch()` only selects approved rows with `retry_count < MAX_RETRY_ATTEMPTS`, so that row was no longer selectable, was not marked `failed`, and produced no manual-review alert.

## Change

- Retryable failures below the final attempt still return to `approved`.
- A retryable failure that reaches `MAX_RETRY_ATTEMPTS` now transitions to:

```text
status = failed
retry_count = MAX_RETRY_ATTEMPTS
requires_review = true
processing_started_at = null
broadcast_tx_hash = null
```

- Sends a high-severity `Payout retries exhausted` alert only after the failed-state DB transition succeeds.
- Stale processing rows that have already exhausted retries are also marked `requires_review = true` and emit the same alert family.

## Validation

Commands run from `/home/shaw/eliza/eliza-wt-10628-payout-retry-exhausted`:

```bash
ELIZA_SKIP_ARTIFACT_SYNC=1 bun install --frozen-lockfile
bun run --cwd packages/core build
bunx @biomejs/biome check packages/cloud/shared/src/lib/services/payout-processor.ts packages/cloud/shared/src/lib/services/__tests__/payout-stale-lock-recovery.test.ts
git diff --check
bun test packages/cloud/shared/src/lib/services/__tests__/payout-stale-lock-recovery.test.ts
```

Results:

- `bun install --frozen-lockfile`: passed.
- `bun run --cwd packages/core build`: passed. This was required so the PGlite-backed cloud/shared test executed the real DB path instead of skipping on missing local workspace build output.
- Biome check: passed for both changed files.
- `git diff --check`: passed.
- Focused payout test: passed with 9 tests, 0 failures, 45 expectations.

Regression proof from the new test `(g) #10628: final retryable failure is failed, not orphaned as unselectable approved`:

- Seeded a redemption as `approved` with `retry_count = 2`.
- Forced a retryable RPC failure before any broadcast.
- Verified `processBatch()` reports one failed redemption.
- Verified the DB row becomes `status = failed`, `retry_count = 3`, `requires_review = true`, `processing_started_at = null`, and `broadcast_tx_hash = null`.
- Verified no raw transaction send occurred.
- Verified one alert was emitted.

Additional stale-lock regression proof from `(f2) #10628: stale-lock recovery fails the row when its recovery strike reaches the retry ceiling`:

- Seeded a redemption as `processing` with no broadcast hash, a stale `processing_started_at`, and `retry_count = 2`.
- Verified stale-lock recovery does not re-approve the row into an unselectable state.
- Verified the DB row becomes `status = failed`, `retry_count = 3`, `requires_review = true`, `processing_started_at = null`, and `broadcast_tx_hash = null`.
- Verified no raw transaction send occurred.
- Verified one alert was emitted.

## Evidence N/A

- Android capture: N/A. This change is isolated to backend payout processing in `packages/cloud/shared`; no Android, app, native, or UI surface changed.
- Screenshot/screen recording: N/A for the same reason.
- Full cloud stack request/response trace: N/A. The touched behavior is a service-level processor path, and the focused PGlite test directly exercises the real `processBatch()` database transition and alert emission.
