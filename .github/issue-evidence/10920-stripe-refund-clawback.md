# 10920 Stripe Refund Clawback Evidence

## Scope

Backend-only Stripe queue and credit ledger fix. No UI, frontend logs,
screenshots, video, audio, or real-LLM trajectories apply.

## Verification

```bash
bun test packages/cloud/shared/src/lib/services/__tests__/credits-reconcile.test.ts
```

Result: 14 pass, 0 fail, 71 expect() calls. This ran the PGlite-backed path with
the test `organizations.credit_balance` CHECK constraint enabled.

```bash
bun test packages/cloud/api/__tests__/stripe-event-clawback.test.ts packages/cloud/api/__tests__/stripe-event-waifu.test.ts
```

Result: 4 pass, 0 fail, 14 expect() calls.

Note: run the shared-service and API queue suites separately. The API queue test
mocks `@/lib/services/credits`, which contaminates the later shared-service
import when both files run in one Bun process.
