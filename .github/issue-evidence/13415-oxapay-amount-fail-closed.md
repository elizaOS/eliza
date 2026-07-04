# #13415 slice — oxapay.ts money-in invoice-amount fail-closed

Scope: `packages/cloud/shared/src/lib/services/oxapay.ts` (`getPaymentStatus`).
Part of the #13415 cloud-shared service-layer fallback sweep. Does not overlap
the in-flight slices: auto-top-up (#13507), payout-processor (#13508),
agent-billing-gate, agent-budgets, referrals, redeemable-earnings.

## Before/after fallback census (oxapay.ts, non-test)

Command:

```
rg -n "\|\|\s*0|\?\?\s*0|Number\.parseFloat|catch\s*\{" packages/cloud/shared/src/lib/services/oxapay.ts
```

Before:

| line | site | verdict |
| --- | --- | --- |
| 227 | `const invoiceAmount = Number.parseFloat(data.amount) \|\| 0;` | **SLOP — fixed.** `amount` is the USD value that `crypto-payments.confirmPayment` credits on a confirmed payment. A missing/non-numeric/`"0"` amount on a `result=100` inquiry coerced to `0`, so a CONFIRMED payment settled while crediting $0 — the user's funds were taken and no credits granted, with only the provider-side record to reconstruct it. |
| 228 | `const nativePayAmount = Number.parseFloat(data.payAmount \|\| "0");` | **Intentional degrade — reshaped.** `nativeAmount` is audit/debug metadata only (never credited; the interface already types it optional). A malformed value now degrades to `undefined` instead of a fake `0`, so audit logs distinguish "provider omitted it" from "paid 0". |
| 314 | `catch { return false; }` in `getSystemStatus` | KEEP — J4-style availability probe; `false` = "OxaPay unreachable/down", which is the designed degrade for a status check. Pre-existing, unmodified. |

After:

- `invoiceAmount`: strict parse; non-finite or `<= 0` throws `OxaPayApiError`
  with the raw amount + trackId, after a structured `logger.error`. The parser
  rejects partial numeric strings such as `"25abc"` / `"25 USD"` instead of
  accepting a `parseFloat` prefix. Every invoice is created with a positive
  amount (`createInvoice` requires it), so a non-positive inquiry amount is a
  malformed provider response, never a valid business state.
- `nativePayAmount`: the same strict decimal parser is used for audit metadata;
  malformed, blank, or partially numeric strings degrade to `undefined` (field
  is optional on `OxaPayPaymentStatus.transactions[]`).

## Blast radius

Callers of `getPaymentStatus` (all in `crypto-payments.ts`): checkPaymentStatus
(:348), on-chain verification (:772), webhook verification (:1150). All three
already run inside try/catch blocks that log and rethrow/fail the request, so
the new throw surfaces as an explicit verification failure instead of a $0
confirmation. The payment row stays `pending` and is retryable once the
provider returns a sane response.

## Focused test output

`bun test --isolate src/lib/services/oxapay.amount-fail-closed.test.ts`:

```
 10 pass
 0 fail
 18 expect() calls
Ran 10 tests across 1 file.
```

Adjacent adapter suite unchanged and green:
`bun test --isolate src/lib/services/payment-adapters/oxapay.test.ts` → 8 pass / 0 fail.

## Checks

- `bunx @biomejs/biome check` on both touched files: clean.
- `bun run audit:error-policy-ratchet`: `no new fallback-slop in touched files`.
- `bun run --cwd packages/cloud/shared typecheck` (tsgo): no diagnostics in any
  `cloud/shared` file; the only errors are pre-existing out-of-package noise in
  `packages/app-core` (`@elizaos/auth/*` module resolution/strictness) plus
  unrelated `src/lib/providers/video/fal-video-generation.ts` dependency and
  strictness errors, all unrelated to this change and identical on base.

## N/A rows

- UI screenshots: N/A — service unit boundary only.
- Model trajectories: N/A — no LLM surface touched.
- Audio: N/A.
- Runtime structured logs: unit-level; the new `logger.error("[OxaPay] Invalid
  invoice amount in inquiry response", ...)` line is exercised in the test
  output above.
