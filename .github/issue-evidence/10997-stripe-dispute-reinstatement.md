# #10997 Stripe Dispute Reinstatement Evidence

## Change

- Added `charge.dispute.funds_reinstated` handling in the Stripe queue.
- Reinstatement is idempotent on `stripe:dispute:<id>:reinstated`.
- The restored amount is capped to the actual applied dispute clawback, so a won dispute cannot over-credit an org.
- Refund/dispute clawbacks are capped at the original credit grant before computing the delta, so Stripe gross amounts above granted credits cannot over-claw.
- Removed a duplicate `DEFAULT_CEREBRAS_TEXT_MODEL` export in the Cloudflare worker stub that made `packages/cloud/api` typecheck fail on the current base.

## Verification

```bash
bunx biome check packages/cloud/api/src/queue/stripe-event.ts packages/cloud/api/__tests__/stripe-event-clawback.test.ts packages/cloud/api/src/stubs/elizaos-core.ts
```

Result: passed (`Checked 3 files`).

```bash
bun test packages/cloud/api/__tests__/stripe-event-clawback.test.ts
```

Result: passed (`6 pass, 0 fail`).

Covered:
- cumulative `charge.refunded` delta clawback
- grant-capped refund clawback
- refund redelivery no-op
- `charge.dispute.funds_withdrawn` dispute-key clawback
- `charge.dispute.funds_reinstated` restoring only applied dispute clawback
- reinstatement no-op when no matching dispute clawback exists

```bash
bun run --cwd packages/cloud/api typecheck
```

Result: passed (`tsgo --noEmit`).

## UI / Live Stripe Evidence

N/A: server-side Stripe queue accounting fix with unit coverage around the event processor. No `packages/app` UI changed. Live Stripe replay was not run because this path requires real Stripe dispute lifecycle events and a funded test account; the focused queue tests exercise the event payloads and idempotency keys directly.
