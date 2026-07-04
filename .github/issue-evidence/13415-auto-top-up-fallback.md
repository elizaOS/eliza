# #13415 evidence — cloud-shared service-layer fallback slop: `auto-top-up.ts` money-gate NUMERIC reads

Slice of the `agent-ready: fallback slop sweep for cloud-shared service layer` sweep.
File: `packages/cloud/shared/src/lib/services/auto-top-up.ts`. Distinct from the sibling
fleet-13415 lane (which owns `agent-budgets.ts`) and from the credit-balance slices
`#13137`/`#13256`/`#13261`/PR `#13355`.

## Fallback census (before → after)

| path:line | read | verdict | fix |
| --- | --- | --- | --- |
| `auto-top-up.ts` `executeAutoTopUp` (was line ~151) | `const amount = Number(org.auto_top_up_amount \|\| 0)` then `if (amount <= 0 \|\| amount > MAX)` | **FAIL-OPEN money gate** — a corrupt `auto_top_up_amount` (`'NaN'::numeric` is a valid Postgres store, reads back as the string `"NaN"`; `"NaN" \|\| 0` = `"NaN"`, truthy → `Number("NaN")` = `NaN`). `NaN <= 0` and `NaN > MAX` are **both false**, so a corrupt amount slips **past** the invalid-amount guard into `paymentIntents.create({ amount: Math.round(NaN * 100) })` = charge with `amount: NaN`. | Read via new `parseAutoTopUpNumber("auto_top_up_amount", ...)` fail-closed boundary; a corrupt amount hits the **existing** invalid-amount path (`disableAutoTopUp` + `success:false`) instead of charging. |
| `auto-top-up.ts` affiliate block (was line ~185) | `const affiliatePercent = Number(referrer.markup_percent)` → `affiliateFeeAmount = amount * (affiliatePercent / 100)` → `totalAmount = amount + affiliateFeeAmount + platformFeeAmount` | **FAIL-OPEN money gate** — a corrupt `markup_percent` NaN poisons `affiliateFeeAmount` → `totalAmount` = `NaN` → `Math.round(NaN * 100)` = `NaN` charged amount. | Read via `parseAutoTopUpNumber("markup_percent", ...)`; on corruption the **best-effort surcharge is dropped** (affiliate attribution + fees reset to 0, base amount still charged) with an observable `logger.error`. Customer's top-up is not denied over a corrupt affiliate record, and no `NaN` total is ever charged. |
| `auto-top-up.ts` `previousBalance = Number(org.credit_balance)` | display-only value passed to the success email | **intentional keep** — not a money gate / decision input | left as-is |
| `auto-top-up.ts` `Number(org.auto_top_up_amount \|\| 0)` / `Number(org.auto_top_up_threshold \|\| 0)` in `getSettings`/`updateSettings` | read-back for display + `validateSettings` (which already `throw`s on non-finite via `Number.isFinite` guard) | **intentional keep** — `validateSettings` already fails closed on non-finite | left as-is |

## Root cause

Postgres `NUMERIC` values arrive as strings at the driver, and `'NaN'::numeric` is a legal
stored value that reads back as `"NaN"`. Every comparison against `NaN` is `false`, so a
bare `Number(...)` read on a money field silently defeats a `<= 0` / `> MAX` range gate and
propagates `NaN` into a Stripe charge. Mirrors the merged fail-closed NUMERIC-boundary
pattern from `#13454` (usage-quotas), `#13474` (app-earnings), `#13482`/`#13486` (agent/
container billing).

## Fix

New colocated `parseAutoTopUpNumber(field, raw)` fail-closed boundary + typed
`CorruptAutoTopUpNumberError`. Throws on `null`/`undefined`/blank/non-finite; allows an
explicit domain `0`. Wired into the two money-computation reads:
- `auto_top_up_amount` → corrupt = same `disableAutoTopUp` + `success:false` path as an
  out-of-range amount (never charges).
- affiliate `markup_percent` → corrupt = drop the surcharge, charge the base amount
  (best-effort surcharge fail-safe), never a `NaN` total.

## Tests (focused error-path)

`packages/cloud/shared/src/lib/services/__tests__/auto-top-up.test.ts` (+8 tests):
- `parseAutoTopUpNumber` unit: parses finite strings/numbers/explicit-0; throws on the
  `"NaN"` read-back (regression guard asserting `Number("NaN")` is `NaN`), on
  null/undefined/blank/non-numeric/Infinity.
- `executeAutoTopUp`: corrupt `auto_top_up_amount` disables + fails, `createPaymentIntent`
  and `addCredits` **never called**; corrupt `markup_percent` charges base `1000` cents
  (not `Math.round(NaN*100)`) with no affiliate metadata and `total_charged: "10.00"`,
  top-up still succeeds; valid markup still applies the `$13.00` surcharge (no behavior
  change).

```
bun test packages/cloud/shared/src/lib/services/__tests__/auto-top-up.test.ts
12 pass / 0 fail / 39 expect() calls
```

## Verification

- `bunx @biomejs/biome check <touched files>` → clean (2 files, no fixes).
- `bun run --cwd packages/cloud/shared typecheck` → **0 errors in `auto-top-up.ts`**; 21
  pre-existing baseline errors in unrelated files (fresh-worktree i18n generated keyword
  data + symlinked-node_modules drift: `core/src/i18n/*`, `shared/src/i18n/*`, `app-core/*`,
  `lib/cache/adapters/node-redis-adapter.ts`, `plugin-mcp/utils/json.ts`,
  `providers/anthropic-web-search.ts`) — none in touched files.
- `node packages/scripts/error-policy-ratchet.mjs` → `no new fallback-slop in touched files`.

## N/A rows

- UI screenshots: N/A — service unit boundary only.
- Model trajectories: N/A.
- Audio: N/A.
- Runtime logs: N/A — service unit boundary only (Stripe/DB not exercised live).
