# #13415 slice — x402-payment-requests settle-path amount fail-closed

Scope: `packages/cloud/shared/src/lib/services/x402-payment-requests.ts`
(`settle()` + `recordAppScopedPaymentEarnings`). Part of the #13415
cloud-shared service-layer fallback sweep. No overlap with in-flight slices:
auto-top-up (#13507), payout-processor (#13508), oxapay (#13527),
agent-billing-gate, agent-budgets, referrals, redeemable-earnings.

## Before/after fallback census (settle path, non-test)

Command:

```
rg -n "Number\(metadata|amountUsd <= 0|\?\? 0" packages/cloud/shared/src/lib/services/x402-payment-requests.ts
```

Before:

| line | site | verdict |
| --- | --- | --- |
| 750 | `const amountUsd = Number(metadata.amountUsd ?? payment.credits_to_add);` computed AFTER `x402FacilitatorService.settle` moved funds | **SLOP — fixed.** `Number(undefined)` and `Number("garbage")` are `NaN`. |
| 442 | `if (amountUsd <= 0) return;` in `recordAppScopedPaymentEarnings` | **SLOP — fixed.** `NaN <= 0` is `false`, so a corrupt amount slipped past the guard into `addPurchaseEarnings(appId, NaN)`, a `purchase_share` transaction with `amount: "NaN"` (`NaN.toFixed(6)`), and a `total_creator_earnings + NaN` SQL update that nulls/poisons the rollup. |
| 394 | `Number(metadata.amountUsd ?? payment.credits_to_add ?? 0)` in `triggerChannelCallback` | KEEP — display-only chat message copy (`formatUsd`); never credited. Unchanged. |
| 808 | `Number(metadata.amountUsd ?? payment.credits_to_add ?? 0)` in `toView` | KEEP — read-model view DTO; never credited. Unchanged. |

After:

- `settle()` validates `amountUsd` (finite AND > 0) **before**
  `decodePaymentPayload`/`x402FacilitatorService.settle` — i.e. before any
  funds move on-chain. A corrupt stored request now fails with
  `X402PaymentRequestError(500, "corrupt_amount")` + structured `logger.error`
  + the existing failure callback, leaving the request un-settled instead of
  taking the payer's money and crediting earnings from NaN. `create()` already
  guarantees a finite positive `amountUsd` in metadata (`bad_amount` guard at
  create-time), so a non-finite/non-positive amount at settle-time is always a
  corrupt record, never a valid state.
- `recordAppScopedPaymentEarnings` gained a defense-in-depth
  `Number.isFinite` check (throws `corrupt_amount`) so no other caller can
  push NaN into the earnings ledgers; the intentional `<= 0` no-op stays for
  legitimate zero-value cases.

## Focused test output

`bun test --isolate src/lib/services/__tests__/x402-app-earnings.test.ts`
(3 existing + 3 new fail-closed tests):

```
 6 pass
 0 fail
 31 expect() calls
Ran 6 tests across 1 file. [2.16s]
```

New tests prove: corrupt metadata + corrupt `credits_to_add` → settle throws
before `x402FacilitatorService.settle` is called (facilitator mock not
invoked, no confirmation, no earnings); missing both amount sources → same;
zero amount → same.

## Checks

- `bunx @biomejs/biome check` on both touched files: clean.
- `bun run audit:error-policy-ratchet`: `no new fallback-slop in touched files`.
- `bun run --cwd packages/cloud/shared typecheck` (tsgo): zero diagnostics
  mentioning x402 or any `cloud/shared` file; only pre-existing out-of-package
  noise (`packages/app-core` `@elizaos/auth/*` resolution + the generated
  `validation-keyword-data.js` artifact), identical on base.

## N/A rows

- UI screenshots: N/A — service unit boundary only.
- Model trajectories: N/A — no LLM surface touched.
- Audio: N/A.
- Runtime structured logs: unit-level; the new
  `refusing to settle request with corrupt amount` log lines appear in the
  test output above.
