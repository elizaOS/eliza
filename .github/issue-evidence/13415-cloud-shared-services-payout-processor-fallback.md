# #13415 — cloud-shared service-layer fallback-slop sweep: `payout-processor.ts` money-out NUMERIC fail-closed slice

Slice of the `packages/cloud/shared` service-layer sweep. Target file:
`packages/cloud/shared/src/lib/services/payout-processor.ts` (a file the issue
flags as a "🚨 CRITICAL SECURITY COMPONENT 🚨" — hot-wallet token payouts).

Distinct from the concurrent sibling `#13415` lane (which owns `agent-budgets.ts`
only) and from every merged `#13416` DB-repository slice.

## Fallback census (before)

The approved-redemption payout path read three `notNull` Postgres `numeric(...)`
columns on `token_redemptions` — which the driver returns as **strings** — via
bare `Number()` / viem `parseUnits()`, with **no fail-closed boundary**:

| path/line | read | corrupt-value behavior (before) | verdict |
| --- | --- | --- | --- |
| `processRedemption` price guard | `Number(redemption.eliza_price_usd)` → `validatePrice` | `NaN` → `slippage = |current-NaN|/NaN = NaN` → `NaN > MAX === false` → **guard FAILS OPEN**, payout authorized against an unvalidatable quote | **fail-open (fix)** |
| `executeSolanaPayout` amount | `BigInt(Math.floor(Number(redemption.eliza_amount) * 10**d))` | `Number('')===0` → `0n` → **zero-token transfer broadcast + confirmed + marked `completed` with a real tx hash** (fabricated success; user gets nothing, pending balance still debited). `Number('NaN')*1e9=NaN` → `BigInt(NaN)` raw `RangeError` | **fabricated-success / raw-throw (fix)** |
| `executeEvmPayout` amount | `parseUnits(redemption.eliza_amount.toString(), d)` | `parseUnits('', d) === 0n` (verified) → same **zero-token fabricated-success** | **fabricated-success (fix)** |
| `markCompleted` ledger | `usdValue = usd_value.toString()` into `total_pending - usdValue` / `total_redeemed + usdValue` SQL; `usdNumber = Number(usd_value)` into `$${usdNumber.toFixed(2)}` description | corrupt `usd_value` → `- 'NaN'` poisons ledger balances / `$NaN` in ledger description. Runs only AFTER broadcast, so a post-broadcast throw would half-record | **ledger-corruption (fix, gated pre-broadcast)** |

`viem.parseUnits('', 9) === 0n` and `Number('') === 0` confirmed empirically on the
pinned toolchain; `'NaN'::numeric` is a legal Postgres store returned as `"NaN"`.

## Fix (fail-closed boundary)

New colocated, exported, pure boundary (mirrors the merged `#13474` app-earnings /
`#13454` usage-quotas parsers):

- `parseRedemptionAmount(field, raw): number` — throws `CorruptRedemptionAmountError`
  on `null`/`undefined`/empty/whitespace/non-finite; allows an explicit domain `0`;
  **never returns `NaN`, never silently substitutes `0`**.

Wired so a corrupt row is refused **before anything is signed or broadcast**, as a
`{ success: false, retryable: false }` `PayoutResult` → routes through `markFailed`
to manual review (non-retryable, because a corrupt row is not transient):

- `processRedemption` top: parse `eliza_amount` (+ reject `<= 0` no-op transfers),
  parse `usd_value` (gated here so `markCompleted` never writes `$NaN`/`- 'NaN'`
  post-broadcast), and — when `ENFORCE_PRICE_VALIDATION` is on — parse
  `eliza_price_usd` (+ reject `<= 0`, whose `Infinity` slippage would be an
  accidental divide-by-zero rejection, not a policy signal).
- `executeSolanaPayout` / `executeEvmPayout` amount reads re-validate through the
  same parser (defense-in-depth: a direct call can never build a zero-token
  transfer either).
- `markCompleted` `usdNumber` uses the parser (already proven finite pre-broadcast).
- `refundStrandedRedemption` also parses `usd_value` before issuing the automatic
  failed-redemption refund. If the refund amount itself is corrupt, the row stays
  `failed`/`requires_review` and the refund is skipped instead of sending
  `NaN`/empty coercion into refund accounting.

Distinct/not-found/unavailable stays distinct from corruption: "not configured"
wallet, expired quote, and a genuinely-valid row are all unaffected (positive
control test proves a healthy row passes the numeric guards and only hits the
wallet boundary).

No `console.*` introduced (structured `logger.error` on every refusal). No
intentional fail-safe keep needed → no new `// error-policy:J<N>` annotation
(this converts silent slop into explicit fail-closed control flow, not a keep).

## Tests

`packages/cloud/shared/src/lib/services/payout-processor.numeric-fail-closed.test.ts`
— `bun test --isolate` (the package's primary runner; its `vitest.config.ts` is a
single-file integration harness):

```
 14 pass
 0 fail
 30 expect() calls
Ran 14 tests across 1 file.
```

Coverage:
- 9 parser unit tests: normal decimal string, numeric input, explicit `0`,
  `'NaN'` regression, `''` regression (the `parseUnits('')===0n` case), whitespace,
  `null`/`undefined`, non-numeric + `Infinity`, error names field+value.
- 5 seam tests through `PayoutProcessorService.processRedemption` (no wallet/DB):
  corrupt `eliza_amount` → non-retryable refuse; empty `eliza_amount` regression →
  refuse (not zero-token success); non-positive amount → refuse; corrupt
  `usd_value` → refuse; **positive control**: a healthy row is NOT over-rejected by
  the numeric guards (falls through to the wallet boundary).

## Gates

- `bun --conditions=eliza-source test --isolate <test>` → **14/14 pass**.
- `bunx @biomejs/biome check <payout-processor.ts + test>` → **clean** (2 files fixed then clean).
- `bun run audit:error-policy-ratchet` → **`no new fallback-slop in touched files`** (EXIT 0).
- `bun run --cwd packages/cloud/shared typecheck` → **17 pre-existing baseline errors**
  in unrelated files (`app-core/@elizaos/auth/*` symlink drift, `node-redis-adapter.ts`,
  `plugin-mcp/utils/json.ts`, `anthropic-web-search.ts`), **0 in the touched files**.
  Identical baseline documented by prior merged cloud-shared slices.

## Non-applicable evidence

- UI screenshots — N/A (server-only service unit boundary).
- Model trajectories — N/A.
- Audio — N/A.
- Runtime logs — N/A (unit boundary; refusal paths emit structured
  `logger.error(...)`, shown inline in the test transcript).

## Collision receipts

- No open PR references `#13415` at claim OR push.
- No open PR touches `payout-processor.ts` at claim OR push.
- No `lalalune` / `NubsCarson` / `roninjin10` payout-processor PR in the last day.
- Sibling `fleet-13415` worktree owns `agent-budgets.ts` ONLY (no payout files).
- Unique worktree path `fleet-13415-payout`; only my intended files staged; diff
  contains no foreign paths.

— [sol-orch]
