# #11022 Stripe Connect Retry Double-Pay Evidence

## Change

- Blocked a Stripe Connect payout retry when the ledger debit is deduplicated and a prior compensating refund exists for the same `idempotency_key`.
- Kept normal same-key retry behavior intact when no refund exists, so Stripe idempotency can still replay a successful or ambiguous transfer.
- Added a primary-read ledger helper that checks normalized earning source IDs without duplicating ledger source-id logic in the route.

## Verification

```bash
bun test packages/cloud/api/__tests__/stripe-connect-transfer-route.test.ts
```

Result: passed (`7 pass, 0 fail`).

Covered:
- successful payout debits once and transfers
- definitive Stripe rejection refunds once
- same-key retry after a refunded rejection returns `409` before any Stripe transfer
- same-key retry without a refund still reaches Stripe idempotency replay
- ambiguous failures hold the debit for reconciliation
- failed debit short-circuits before Stripe

```bash
bunx biome check packages/cloud/api/v1/earnings/payout/stripe-connect/transfer/route.ts packages/cloud/api/__tests__/stripe-connect-transfer-route.test.ts packages/cloud/shared/src/lib/services/redeemable-earnings.ts
```

Result: passed (`Checked 3 files`).

```bash
bun run --cwd packages/cloud/api typecheck
```

Result: passed (`tsgo --noEmit`).

```bash
bun run --cwd packages/cloud/shared typecheck
```

Result: passed (`tsgo --noEmit`).

## UI / Live Stripe Evidence

N/A: server-side admin-gated Stripe Connect money-path fix. No `packages/app` UI changed. Live Stripe replay was not run because the exploit requires a real transient Stripe rejection/retry sequence against Connect transfers; the focused route tests exercise the exact pre-Stripe guard and preserve the intended idempotent replay path.
