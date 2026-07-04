# #13415 slice — app-charge-requests corrupt-amount read fail-closed

Scope: `packages/cloud/shared/src/lib/services/app-charge-requests.ts`
(`toChargeRequest`). Part of the #13415 cloud-shared service-layer fallback
sweep. No overlap with in-flight slices: auto-top-up (#13507),
payout-processor (#13508), oxapay (#13527), x402 settle (#13530),
agent-billing-gate, agent-budgets, referrals, redeemable-earnings.

## Before/after fallback census (non-test)

Command:

```
rg -n "Number\(payment|Number\(metadata" packages/cloud/shared/src/lib/services/app-charge-requests.ts
```

Before:

| line | site | verdict |
| --- | --- | --- |
| 120 | `amountUsd: Number(payment.expected_amount)` in `toChargeRequest` | **SLOP — fixed.** `expected_amount` is a DB string column; `Number(null)` is a plausible-but-wrong `0` and `Number("garbage")` is `NaN`. The materialized `amountUsd` flows into Stripe checkout (`Math.round(amountUsd * 100)` → `NaN` unit_amount, `credits: "NaN"` metadata via `.toFixed(2)`) and into `cryptoPaymentsService.createPayment` for OxaPay. |

After:

- `toChargeRequest` parses with `Number(...)` (not `parseFloat` — parseFloat
  accepts `"12garbage"` as `12`) and requires a finite in-range value. `create()`
  enforces $1–$10,000 at write-time (`normalizeAmount`), so the read gate
  mirrors those `$1 <= amount <= $10,000` bounds; any value outside them is
  always corruption.
- A corrupt row reads as `null`, which every payment endpoint already treats
  as "Charge request not found" — the corrupt charge is unpayable. List
  endpoints (`listForApp`) drop the corrupt row and keep serving the org's
  healthy rows. A structured `logger.error` with the raw value keeps the
  fault observable (not a silent skip).

Null-vs-throw rationale: `toChargeRequest` is the shared read gate for get,
list, and both checkout paths, and it already signals "not a usable charge"
via `null` (kind/app_id mismatch). Reusing that channel means every existing
caller fails closed with zero new unhandled-throw surface, while the error
log preserves observability.

## Focused test output

`bun test --isolate src/lib/services/__tests__/app-charge-amount-fail-closed.test.ts`:

```
 8 pass
 0 fail
 9 expect() calls
Ran 8 tests across 1 file. [1.51s]
```

Covers: healthy row reads verbatim; non-numeric / null / zero / negative /
oversized / partially-numeric (`"12abc"`) amounts read as null; a corrupt row
cannot enter the Stripe checkout path (`Charge request not found`).

Adjacent suite unchanged and green:
`app-charge-callback-cross-tenant.test.ts` → 7 pass / 0 fail (real-PGlite).

## Checks

- `bunx @biomejs/biome check` on both touched files: clean.
- `bun run audit:error-policy-ratchet`: `no new fallback-slop in touched files`.
- `bun run --cwd packages/cloud/shared typecheck` (tsgo): zero diagnostics in
  any touched file; only pre-existing out-of-package noise (`packages/app-core`
  `@elizaos/auth/*` resolution + the generated `validation-keyword-data.js`
  artifact), identical on base.

## N/A rows

- UI screenshots: N/A — service unit boundary only.
- Model trajectories: N/A — no LLM surface touched.
- Audio: N/A.
- Runtime structured logs: unit-level; the new `Refusing to read charge
  request with corrupt expected_amount` lines appear in the test output above.
