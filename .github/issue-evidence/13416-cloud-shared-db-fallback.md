# Evidence — #13416 fallback slop sweep: cloud-shared DB repositories (usage-quotas slice)

Agent-ready successor to #12788 for the DB/repository side of `packages/cloud/shared`.
This PR ships the **usage-quotas spend-gate slice**: the corrupt-NUMERIC-row → fail-open
class on the quota enforcement path. Other repositories in the 47-file inventory remain
open for follow-up slices (this issue stays open).

## Before/after fallback census (this slice)

Inventory re-run on `origin/develop` (base `08b5e87ff0`):

```
grep -rn -E 'Number\(|parseFloat\(|\?\? 0|\|\| \[\]' packages/cloud/shared/src/db/repositories/**  (non-test)
```
150 raw candidate hits across the repository tree. This slice addresses the **highest-severity
subset**: the `usage_quotas.credits_limit` / `usage_quotas.current_usage` reads that gate metered
spend. These columns are Postgres `NUMERIC` (surfaced as strings); a present-but-corrupt value
flows through a bare `Number(...)` as `NaN`, and every comparison against `NaN` is `false`, which
**silently disables the spend gate** (`newUsage > NaN` → allowed; `usage >= NaN` → not exceeded).

## Path/line/verdict table

| Path | Line(s) (pre-fix) | Field | Verdict | Fix |
|---|---|---|---|---|
| `src/db/repositories/usage-quotas.ts` | 77-78 `checkQuotaExceeded` | current_usage, credits_limit | **fail-open bug** — `NaN >= NaN` = false → "not exceeded" over corrupt row | parse via `parseUsageQuotaNumber` (throws on corrupt) |
| `src/db/repositories/usage-quotas.ts` | 111-116 `getCurrentUsage` | current_usage, credits_limit | fabricated `NaN` in reporting DTO | same fail-closed reader |
| `src/lib/services/usage-quotas.ts` | 102-103, 130-131 `checkQuota` (model + global) | current_usage, credits_limit | **fail-open bug** — `newUsage > NaN` = false → `{ allowed: true }` (quota bypass, unbounded metered spend) | same fail-closed reader |
| `src/lib/services/usage-quotas.ts` | 220-221, 229-230 `getCurrentUsage` | current_usage, credits_limit | fabricated `NaN` usage % in reporting DTO | same fail-closed reader |

New boundary: `src/db/repositories/usage-quotas-numeric.ts` — `parseUsageQuotaNumber(value, field)`
throws on null/undefined/empty/whitespace (missing) and on non-finite (`NaN`/`Infinity`/non-numeric).
Explicit domain zero (`"0.00"`, `0`) is allowed. Mirrors the fail-closed reader convention from the
sibling app-credit-balances slice (#12788 family).

Fail-closed rationale: for a spend gate, denying (or surfacing a read error) on a corrupt limit is
security-correct — better to reject a request than to grant unbounded metered usage over a
corrupted quota row. "No quota configured" (no rows) remains `allowed` — that is explicit domain
policy, not a corrupt read, and is preserved + tested.

## Focused test output

`bun test src/db/repositories/usage-quotas-numeric.test.ts src/lib/services/__tests__/usage-quotas-fail-closed.test.ts`

```
 17 pass
 0 fail
 26 expect() calls
```

Coverage:
- helper: well-formed / numeric / zero (allowed) / corrupt-string throws / NaN throws / Infinity
  throws / null|undefined|empty|whitespace throws / field-name in error.
- regression guard: pins that a bare `Number(...)` comparison fails OPEN on a corrupt limit, and
  that the fail-closed reader throws on that same value.
- service seam: `checkQuota` allows with headroom, denies when exceeded, THROWS (fails closed)
  on a corrupt global limit and a corrupt model limit, allows when no quota configured;
  `getCurrentUsage` throws on corrupt `current_usage`, returns healthy breakdown for good rows.

## Verification

- `bunx @biomejs/biome check <touched files>` → **clean** (5 files, no fixes applied).
- `bun run audit:error-policy-ratchet` → **clean** (`no new fallback-slop in touched files`).
- `bun run --cwd packages/cloud/shared typecheck` → **zero errors in touched `usage-quotas` files**;
  17 pre-existing baseline errors remain in unrelated files (`app-core/services/account-pool.ts`,
  `coding-account-bridge.ts`, `plugin-mcp/utils/json.ts`, `anthropic-web-search.ts`,
  `node-redis-adapter.ts`) — untouched by this PR.
- `git diff --check origin/develop...HEAD && git diff --check` → clean.
- Migrations: none touched (append-only respected).

## DB row / domain artifact examples

- Healthy: `credits_limit="100.00"`, `current_usage="10.00"` → `checkQuota(amount=5)` = `{ allowed: true }`.
- Exceeded: `credits_limit="100.00"`, `current_usage="99.00"` → `checkQuota(amount=5)` = `{ allowed: false, reason: "Weekly quota exceeded..." }`.
- Corrupt (the bug): `credits_limit="corrupt"` → previously `{ allowed: true }` (bypass); now **throws** `Unable to read extra usage credits_limit`.

## N/A rows

- UI screenshots: N/A (no UI surface touched).
- Model trajectories: N/A.
- Audio: N/A.

## Human involvement

None. The "no quota configured → allowed" behavior is existing domain policy (preserved + tested),
not an engineering default requiring a decision.
