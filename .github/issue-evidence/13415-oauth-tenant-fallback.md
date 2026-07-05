# #13415 — cloud-shared fallback sweep slice 2: oauth + tenant-db + agents

Verified untouched by every in-flight fallback-sweep branch before starting.

## Fail-open bugs fixed (behavioral)

| file / location | before | after |
|---|---|---|
| oauth/cache-version.getOAuthVersion | `return version ?? 0` — failed cache read read as version 0 | first-use miss on reachable backend → 0; unreachable backend → throws (revoked token can't resurface under stale key) |
| oauth/cache-version.incrementOAuthVersion | `cache.incr` fabricates `1` when backend down → wrong key invalidated | throws when backend unavailable before incr |
| oauth-service.listConnections (x2 catches) | DB-read / adapter-query failure → warn + partial/empty list (reads as "not connected") | J2 rethrow with cause; zero-rows still returns [] |
| generic-adapter.findCredential / listConnections / ownsConnection | catch → `undefined` / `[]` / `false` on any error | propagate; the removed catches only guarded a Postgres enum-mismatch that **cannot occur** (all 9 generic platforms ∈ `platform_credential_type`) |
| secrets-adapter-utils.deletePlatformSecrets | swallowed per-secret delete failure | fail-closed-fix |
| oauth2.extractUserInfo default branch | swallow | fail-closed-fix; mapped-branch console→logger |

## Annotated (justified, no behavior change)
generic-adapter decryptTokenSecret / refresh-persist / outer-refresh / revoke-delete (J2/J6); oauth2 secret-cleanup (J2); agents.getRoomContext fire-and-forget cache write (J*). provider-registry / direct-pg-executor / rooms: already fail closed — test-only.

## Verification
- 42 error-path tests (bun:test) — pass; each proves internal-failure PROPAGATES vs designed-empty stays distinguishable, driving the real exported functions.
- Existing oauth + agents suites: 50 pass / 0 fail (no regression).
- `biome check` clean; `audit:error-policy-ratchet` → "no new fallback-slop in touched files".
- typecheck: 0 new TS2xxx errors in touched source; pre-existing repo-wide drizzle-orm declaration noise (`dist/node_modules/drizzle-orm` missing types → TS7016 and its downstream implicit-any) unchanged and unrelated.
- Caller safety: cache-version callers (oauth-service.getValidToken; invalidation.ts via Promise.allSettled; revoke/refresh) and generic-adapter callers surface the new throws at a route boundary — correct fail-closed. Normal (non-error) paths are unaffected (throws only on real backend failure).

## N/A
UI screenshots / model trajectories / audio — N/A (server auth services, no UI/model/audio path). Runtime logs — N/A - service unit boundary only (behavior proven by error-path tests).
