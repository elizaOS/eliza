# #13415 — cloud-shared fallback sweep slice 8: user/DB services

users, user-metrics, user-mcps, wallet-signup. Verified untouched at file level.

## Findings
These services now keep read-path DB failures distinct from designed-empty
results (no swallow-to-null/[]/false), and wallet signup parses
`INITIAL_FREE_CREDITS` strictly with `Number()` after full-token validation.
- **users.ts** — added grep-able `// error-policy:J2/J6` on the 4 kept catches
  (read-replica→primary failover rethrow; best-effort IAC cache eviction; org-
  detach rollback that rethrows the original error). No behavior change. The
  personal-org `$0.00` credit seed + old-org key deactivation left untouched
  (money-path-flagged).
- **user-metrics** — no source change; already fail closed.
- **user-mcps** — read paths were already fail closed; the affiliate/referrer
  money-path lookup now propagates instead of log-and-continuing into a charge
  that silently drops owed fee metadata.
- **wallet-signup** — malformed or negative `INITIAL_FREE_CREDITS` now throws
  during config resolution instead of accepting a `parseFloat` prefix or
  falling back to the default. Kept race-recovery catches are annotated; optional
  welcome-credit grant failure returns explicit withheld metadata when the caller
  does not require the grant.

## Verification
24 new error-path `bun:test` cases pass under `--isolate` (the CI invocation),
proving an internal DB failure PROPAGATES (never reads as "no user"/"no MCP")
while a genuine not-found stays a distinct designed-empty signal — driving the
real exported services. biome clean; `audit:error-policy-ratchet` → "no new
fallback-slop".

(`user-database` deferred: its tenant-DB-provisioning error-path test is
timing-sensitive in grouped runs; needs a deterministic harness — separate PR.)

## N/A
UI/model-trajectory/audio — N/A (server user-data services). Runtime traces —
N/A - unit-boundary error-path coverage; no route surface added.
