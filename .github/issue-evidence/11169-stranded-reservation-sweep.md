# Issue #11169 - Stranded Reservation Sweep Evidence

## Scope

- Adds `credit_transactions.settled_at` and a marker-aware partial index for unsettled synchronous reservations.
- Marks new reservation debits with `settlement_marker = credit_reservation_v1`.
- Settles marker-aware stale reservations from a cron route using a compare-and-set `settled_at IS NULL` transaction.
- Treats pre-marker reservation rows as ambiguous and migration-backfills them as settled so the automatic sweep is forward-safe.
- Handles already-written keyed settlement rows without minting another refund/overage.

## Local Verification

```text
bun run --cwd packages/cloud/api codegen
=> wrote _router.generated.ts (617 mounted, 0 unconverted)

bunx biome check packages/cloud/shared/src/db/schemas/credit-transactions.ts packages/cloud/shared/src/db/migrations/0164_credit_reservation_settled_at.sql packages/cloud/shared/src/lib/services/credits.ts packages/cloud/shared/src/lib/services/__tests__/credits-reconcile.test.ts packages/cloud/api/cron/sweep-credit-reservations/route.ts packages/cloud/shared/src/lib/cron/cloudflare-cron.ts packages/cloud/api/src/_router.generated.ts
=> Checked 6 files. No fixes applied.

git diff --check
=> clean

bun test --conditions eliza-source packages/cloud/shared/src/lib/services/__tests__/credits-reconcile.test.ts
=> 24 pass, 0 fail, 125 expect() calls
```

## Typecheck Note

```text
bun run --cwd packages/cloud/shared typecheck
=> blocked in this sparse Windows worktree by missing ambient dependencies/types unrelated to this change
   (examples: pg declarations, drizzle-kit/api, ai, jose, viem, @modelcontextprotocol/sdk, stripe, @solana/*).
```

## UI / Media

N/A - backend cron/database money-path fix; no user-facing UI surface.
