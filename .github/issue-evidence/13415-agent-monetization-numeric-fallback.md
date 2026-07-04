# #13415 — cloud-shared service-layer fallback slop: `agent-monetization.ts` NUMERIC fail-closed

Slice of the `packages/cloud/shared/src/lib/services/**` fallback-slop sweep.
Distinct file from every prior/live #13415 slice (auto-top-up, agent-billing-gate,
token-redemption-secure, payout-processor, oxapay, agent-budgets, credits,
redeemable-earnings, payout-status, x402).

## Vulnerability (money-out fail-open)

`AgentMonetizationService.getAgentMonetization` read two Postgres `NUMERIC`
columns via a bare `Number(...)`:

```ts
markupPercentage: Number(agent.inference_markup_percentage || 0),
totalEarnings:    Number(agent.total_creator_earnings),
```

Postgres accepts `'NaN'::numeric` as a **valid** stored value, so a poisoned row
reads back as the driver string `"NaN"` and `Number("NaN")` is `NaN`. That NaN
then poisoned downstream consumers **silently** (no throw ever fires because every
ordering / threshold comparison against `NaN` is `false`):

- the service's own creator-markup math — `estimateCost` /
  `processUsage`: `baseCost * (markupPercentage / 100)` → `NaN` → a fabricated /
  garbage creator markup;
- `getEarningsSummary`: `sum + Number(a.total_creator_earnings)` → `NaN` total, and
  the `.sort((a,b) => Number(...) - Number(...))` ranking becomes arbitrary;
- the display route `api/v1/agents/[agentId]/monetization/route.ts`:
  `info?.totalEarnings || 0` collapsed the NaN into a **fabricated healthy `$0`**
  over a corrupt earnings ledger (`NaN || 0 === 0`).

## Fix (fail closed)

New colocated, exported, pure `parseAgentMonetizationNumber(value, field)` +
`CorruptAgentMonetizationNumberError`:

- throws on `null` / `undefined` / blank / non-finite (`NaN`, `Infinity`) / non-numeric;
- preserves an explicit domain zero (`"0"`, `"0.00"`) and negative domain values.

Wired into both NUMERIC read sites:

- `getAgentMonetization`: `markupPercentage` (null-safe default 0 preserved for the
  NOT-NULL-with-`"0.00"`-default column; a **corrupt** value throws) + `totalEarnings`
  (throws on corrupt).
- `getEarningsSummary`: each monetized agent's `total_creator_earnings` is read once
  through the boundary before summing / ranking; a corrupt row throws instead of
  poisoning the summary.

The display route already wraps the call in `try/catch → failureResponse`, so a
corrupt row now surfaces an observable error instead of a fabricated `$0`.

Mirrors the merged NUMERIC fail-closed slices #13454 / #13474 / #13482 / #13486 /
#13503 / #13504 / #13507.

## Path / verdict table

| path | line(s) | before | after |
| --- | --- | --- | --- |
| `agent-monetization.ts` `getAgentMonetization` | markup + earnings reads | `Number(row.<numeric>)` → NaN on corrupt | `parseAgentMonetizationNumber(...)` throws (markup null-safe default 0) |
| `agent-monetization.ts` `getEarningsSummary` | sum + sort + map | `Number(row.total_creator_earnings)` ×N → NaN | single boundary read per row, throws on corrupt |
| `agent-monetization.ts` `recordCreatorEarnings` | `earnings <= 0` guard + `new Decimal(earnings)` | already fail-loud (Decimal(NaN) throws) | unchanged |
| `agent-monetization.ts` `estimateCost` / `processUsage` | `markupPercentage` param | consumer-supplied; would inherit a corrupt read via `getAgentMonetization` | protected upstream by the read boundary |

## Verification

- Focused tests: `packages/cloud/shared/src/lib/services/__tests__/agent-monetization-numeric-fail-closed.test.ts` — **11/11 pass** (parser boundary exhaustive incl `'NaN'`/`Infinity`/blank fail-open regressions; `getAgentMonetization` healthy/corrupt-markup/corrupt-earnings/null-default/missing-agent; `getEarningsSummary` healthy sum+rank / single-corrupt-row-fails-closed).
- `bunx @biomejs/biome check <touched files>` — clean.
- `bun run audit:error-policy-ratchet` — `no new fallback-slop in touched files` (EXIT 0).
- `bun run --cwd packages/cloud/shared typecheck` — 17 pre-existing baseline errors in unrelated files (`app-core/account-pool.ts`, `app-core/coding-account-bridge.ts`, `node-redis-adapter.ts`, `plugin-mcp/utils/json.ts`, `anthropic-web-search.ts`), **zero in `agent-monetization.ts`** — identical baseline to the merged sibling cloud-shared slices.
- `git diff --check` — clean.

## N/A rows

- UI screenshots: N/A — service unit boundary only.
- Model trajectories / audio: N/A — no such surface touched.
- Runtime logs: N/A — service unit boundary; the fix converts a silent NaN into a thrown `CorruptAgentMonetizationNumberError` surfaced by the route's existing `failureResponse`.
