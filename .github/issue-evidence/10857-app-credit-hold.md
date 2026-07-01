# 10857 App Credit Hold Evidence

Issue: https://github.com/elizaOS/eliza/issues/10857

## What Was Verified

- Monetized `X-App-Id` inference now creates an app-credit reservation before model work instead of doing a read-only balance check.
- The upfront reservation uses the existing atomic org-ledger debit path (`reserveAndDeductCredits`) through `AppCreditsService.deductCredits`.
- Settlement reuses the existing app reconciliation path for success, abort, and provider-error cases.
- Creator earning idempotency uses separate stable keys for the estimate and any later overage, so overage earnings are not deduped away.
- `/v1/messages` no longer contains the stale `checkBalance` + anonymous-reservation app-credit path.
- `/v1/chat/completions` was updated to the same reservation helper because it had the same `X-App-Id` advisory-check pattern.

## Commands Run

```bash
bunx biome check --write packages/cloud/shared/src/lib/services/app-credits.ts packages/cloud/shared/src/lib/services/__tests__/app-credits-ledger.test.ts packages/cloud/api/v1/messages/route.ts packages/cloud/api/v1/chat/completions/route.ts
bun test packages/cloud/shared/src/lib/services/__tests__/app-credits-ledger.test.ts
bun test packages/cloud/api/__tests__/messages-iac-fast-path.test.ts packages/cloud/api/__tests__/chat-completions-streaming-credit-leak.test.ts
rg -n "checkBalance\\(|calculateCostWithMarkup\\(|createAnonymousReservation\\(|estimatedBaseCost: 0|No upfront debit" packages/cloud/api/v1/messages/route.ts packages/cloud/api/v1/chat/completions/route.ts
bun run --cwd packages/cloud/shared typecheck
bun run --cwd packages/cloud/api typecheck
```

## Results Reviewed

- Biome: 4 files checked, no fixes needed after final pass.
- App-credit ledger suite: 25 tests passed. New coverage proves upfront app inference reservation, pre-model insufficient-credit failure, zero-cost settlement refund/reversal, and distinct creator-earning idempotency keys.
- `/v1/messages` route test: 2 tests passed.
- Source grep: no stale app-credit advisory-check or `estimatedBaseCost: 0` path remains in `/v1/messages` or `/v1/chat/completions`; remaining `createAnonymousReservation()` matches are non-app optimistic billing fallbacks.
- Chat-completions route test: blocked by incomplete linked dependency tree in this worktree, ending at missing `redis` from `packages/cloud/shared/src/lib/cache/client.ts`.
- `packages/cloud/shared` and `packages/cloud/api` typechecks: blocked by the same incomplete linked dependency tree (`@cloudflare/workers-types`, `redis`, `uuid`, `viem`, `decimal.js`, and other top-level dependency links missing from the local install).

## Evidence N/A / Deferred

- UI screenshots/video: N/A, no UI changed.
- Migration up/down and DB rows: N/A, no schema or migration changed.
- Live Cloud request trace: not captured in this local pass because the worktree dependency install is incomplete and no live Cloud billing credentials/model keys were configured. The PR includes deterministic service-level coverage of the atomic debit and route-level `/v1/messages` import coverage.
