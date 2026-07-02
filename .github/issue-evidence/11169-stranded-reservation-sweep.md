# Issue #11169 - Stranded Reservation Sweep Evidence

## Scope

- Adds `credit_transactions.settled_at` and a marker-aware partial index for unsettled synchronous reservations.
- Marks new reservation debits with `settlement_marker = credit_reservation_v1`.
- Stores each reservation's `estimated_cost` / `reservation_buffer` so stale settlement uses the actual reservation math, including fixed-amount reservations.
- Marks app-chat upfront holds with `settlement_marker = app_chat_reservation_v1` and threads the hold transaction id through streaming/non-streaming reconciliation.
- Marks linked app-chat reservation holds settled after refund/charge/no-op reconciliation so the cron sweep can safely recover only genuinely stranded holds.
- Settles marker-aware stale reservations from a cron route using a compare-and-set `settled_at IS NULL` transaction.
- Treats pre-marker generic and app-chat-like reservation rows as ambiguous and migration-backfills them as settled so the automatic sweep is forward-safe.
- Handles already-written keyed settlement rows without minting another refund/overage.

## Local Verification

```text
bun run --cwd packages/cloud/api codegen
=> wrote _router.generated.ts (619 mounted, 0 unconverted); git diff for the generated router is empty

bun run --cwd packages/cloud/shared db:check-migrations
=> drizzle-kit check: Everything's fine

bunx @biomejs/biome check packages/cloud/shared/src/lib/services/credits.ts packages/cloud/shared/src/lib/services/app-credits.ts packages/cloud/shared/src/lib/services/__tests__/credits-reconcile.test.ts packages/cloud/shared/src/lib/services/__tests__/app-credits-ledger.test.ts 'packages/cloud/api/v1/apps/[id]/chat/route.ts' 'packages/cloud/api/v1/apps/[id]/chat/stream-refund.ts' packages/cloud/api/__tests__/apps-chat-stream-refund.test.ts packages/cloud/api/__tests__/apps-chat-nonstreaming-settle-guard.test.ts packages/cloud/shared/src/db/schemas/credit-transactions.ts --files-ignore-unknown=true
=> Checked 9 files. No fixes applied.

git diff --check
=> clean

bun test --isolate --coverage-reporter=lcov --conditions eliza-source packages/cloud/shared/src/lib/services/__tests__/credits-reconcile.test.ts packages/cloud/shared/src/lib/services/__tests__/app-credits-ledger.test.ts packages/cloud/api/__tests__/apps-chat-stream-refund.test.ts packages/cloud/api/__tests__/apps-chat-nonstreaming-settle-guard.test.ts
=> 68 pass, 0 fail, 340 expect() calls
```

## Typecheck Note

```text
bun run --cwd packages/cloud/shared typecheck
=> currently blocked outside this change by app-core/agent generated-export plumbing:
   ../../app-core/src/services/coding-account-bridge.ts cannot resolve
   @elizaos/agent/utils/atomic-json.

bun run --cwd packages/cloud/api typecheck
=> currently blocked outside this change by the team credential pool boundary:
   cloud/shared imports @elizaos/app-core/account-pool, which is not
   resolvable from the package typecheck.
```

## UI / Media

N/A - backend cron/database money-path fix; no user-facing UI surface.
