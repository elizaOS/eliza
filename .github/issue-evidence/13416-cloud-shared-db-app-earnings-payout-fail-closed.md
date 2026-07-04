# #13416 evidence — app-earnings payout/withdrawal NUMERIC fail-closed slice

Successor slice under the cloud-shared DB-repository fallback-slop sweep (#13416).
Distinct from my prior usage-quota slice (PR #13454).

## Path / pattern / verdict

| Path | Pattern | Verdict |
| --- | --- | --- |
| `packages/cloud/shared/src/db/repositories/app-earnings.ts` `processWithdrawal` | `Number(earnings.payout_threshold)` / `Number(earnings.withdrawable_balance)` on a money-out gate | FAIL-OPEN — corrupt NUMERIC → `NaN`; `amount < NaN` and `NaN < amount` both false → minimum-payout gate + insufficient-balance pre-check bypassed. Fixed. |
| `app-earnings.ts` `processIdempotentWithdrawal` | `Number(earnings.payout_threshold)` inside the txn threshold gate | FAIL-OPEN — same NaN bypass of the minimum-payout floor. Runs before the idempotency-key insert, so a corrupt row now aborts with no phantom claim. Fixed. |
| `app-earnings.ts` `!updated` recovery reads (both paths) | `Number(current?.withdrawable_balance ?? 0)` | Would surface `"NaN"` in the user-facing message on a corrupt row. Now `undefined` → domain 0, present-but-corrupt → throws. Fixed. |
| `app-earnings.ts` `getEarningsSummary` / `getDailyEarnings` (lines 190/243) | `Number(row.total)` on `COALESCE(SUM(...), 0)` | AUDITED — read-only display aggregation, never null, NOT a money-out gate. Left as-is (out of scope for this fail-closed slice). |

## The bug (fail-open money-out gate)

`payout_threshold` and `withdrawable_balance` are `notNull` Postgres NUMERIC
columns that arrive as strings. A corrupt value (driver quirk / migration
artifact / manual DB edit) read through a bare `Number(...)` becomes `NaN`.
Because every `< NaN` comparison is false:

- `amount < threshold` → a sub-threshold payout passes the minimum-payout floor.
  This gate has **NO DB-level backstop** (unlike the balance debit, which the
  `gte(withdrawable_balance, amount)` predicate protects race-safely).
- `withdrawable < amount` → the insufficient-balance pre-check is bypassed.

## The fix (fail closed)

New `app-earnings-numeric.ts` boundary `parseEarningsNumber(value, fieldName)`:
throws on null/undefined/empty/whitespace and on any non-finite parse, allows an
explicit domain zero. Wired into all four withdrawal-gate reads (two
`processWithdrawal`, two `processIdempotentWithdrawal`). In the idempotent path
the throw happens before the idempotency-key insert, so a corrupt row rolls the
transaction back with no phantom claim; the plain-Error throw propagates past the
`WithdrawalRollback`-only catch, so it fails loud rather than fabricating success.
Mirrors the established `parseUsageQuotaNumber` pattern from PR #13454.

## Tests — `__tests__/app-earnings-numeric.test.ts` (9/9 green)

```
bun test src/db/repositories/__tests__/app-earnings-numeric.test.ts
 9 pass / 0 fail / 19 expect() calls
```

- parser: well-formed string, numeric literal, explicit zero, null/undefined,
  empty/whitespace, REGRESSION (corrupt → throws not NaN, incl. Infinity/NaN/`12.3.4`).
- gate wiring (stubbed `findByAppId`, no DB needed — Postgres/PGlite won't store a
  corrupt NUMERIC): healthy sub-threshold rejection still holds; corrupt
  `payout_threshold` **throws** instead of allowing a $10 payout under the $25
  floor; corrupt `withdrawable_balance` **throws** instead of bypassing the
  balance pre-check.

## Other gates

- `bunx @biomejs/biome check <touched>` — clean (import-order autofix applied).
- `bun run audit:error-policy-ratchet` — "no new fallback-slop in touched files".
- `bun run typecheck` (tsgo) — 0 errors in touched files; the 17 remaining are
  pre-existing baseline noise (`@elizaos/auth` symlink resolution in app-core,
  node-redis-adapter, plugin-mcp/json, anthropic-web-search) identical on
  `origin/develop`.
- `codex review --uncommitted` — clean: "I did not identify any introduced
  correctness, security, or maintainability issues that warrant an inline finding."

## N/A

- Model trajectories / audio: N/A — no changed view invokes those flows.
- Screenshots: N/A — non-visual DB-repository change.

Issue stays open for the remaining ~47-file repo inventory.

— [sol-orch]
