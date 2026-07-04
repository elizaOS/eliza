# #13417 — cloud-shared cache-invalidation fail-closed slice (distinct from lalalune PR #13459 json-parsing slice)

Slice of the `packages/cloud/shared/src/lib` fallback sweep focused on the
**cache-invalidation fail-open** on security-sensitive paths (auth / credential
revocation). Adjacent slices (`#13416` DB repositories, `#13415` service layer)
are owned by sibling lanes; this slice is the `cache/` + credential-revocation
boundary and does not overlap them.

## Root cause (fabricated-success / fail-open)

Cache invalidation is security-sensitive: revoking an API key, logging a user
out, or changing a permission all depend on the stale cached copy actually being
removed. Three layers silently reported a **failed** delete as a **successful**
invalidation:

1. `CacheClient.del(key)` — swallowed a backend `del` failure (logged a warning)
   and returned `void`. The failure was invisible to every caller.
2. `CacheClient.delPattern(pattern)` — returned `void`; a hit on the
   runaway-iteration guard left matching keys behind but returned normally,
   indistinguishable from a complete sweep.
3. `service-cache.invalidateCache` / `invalidateCachePattern` — wrapped the
   delete in a `try/catch` that swallowed every error and returned normally.
4. `apiKeysService.invalidateCache(keyHash)` (live revoke/delete/deactivate
   path) and `invalidateInferenceAuthContextByKeyHash` (the #9899 inference
   hot-path auth-context entry) fired `cache.del` and **discarded** the result.

Net effect: if Redis `del` failed (backend down / network blip) during a
revoke, the revoke path completed "successfully" while the **revoked API key /
logged-out session stayed in cache and kept authenticating until its TTL
lapsed** (validation TTL 10m, inference auth-context TTL 60s). A fail-open on a
credential-revocation boundary.

## Fix (fail closed, additive & backward-compatible)

- `CacheClient.del` keeps its `Promise<void>` best-effort contract (delegates to
  the new method, discarding the result) so the ~20 existing best-effort
  callers are untouched. Added `delConfirmed(key): Promise<boolean>` returning
  `true` only when the delete is confirmed against the backend (or no backend is
  configured, so nothing to invalidate), `false` when a configured backend
  rejected it.
- `CacheClient.delPattern` keeps `Promise<void>`; added
  `delPatternConfirmed(...): Promise<boolean>` returning `false` when the
  runaway-iteration guard left matching keys behind (partial sweep).
- `service-cache.invalidateCache` / `invalidateCachePattern` now **throw** a new
  typed `CacheInvalidationError` (error-policy:J1) when the delete is not
  confirmed — no more swallow-and-return. `invalidateCacheBatch` attempts every
  key (`Promise.allSettled`) and throws naming the exact keys still potentially
  served stale.
- `apiKeysService.invalidateCache` throws when either the validation-cache or
  inference-auth-context delete is unconfirmed. Because `update`/`delete`/
  `deactivate` invalidate BEFORE the DB mutation, a failed invalidation now
  aborts before the row is revoked — the key stays consistently
  active-and-cached, never DB-revoked-but-cache-live.
- `invalidateInferenceAuthContextByKeyHash` returns the confirmation signal
  (its `api-keys` caller inspects it); `invalidateInferenceAuthContextsByKeyHashes`
  (the ban / org-deactivate fan-out) **throws** on any unconfirmed delete so its
  `await`-only callers (admin ban, user deactivate) fail closed automatically —
  the org-deactivate caller keeps its deliberate best-effort `try/catch`.
- `inference-billing-fast-path` now contains the uncollected-debit
  user-IAC eviction as explicit best-effort (error-policy:J5). The org balance
  hint is already invalidated before the background user eviction, so the next
  request leaves the optimistic path even if the user fan-out cache delete is
  temporarily unavailable.
- **Configured-vs-unavailable split (codex round-1 P1):** `delConfirmed` /
  `delPatternConfirmed` return `true` only when NO backend is configured (nothing
  could be caching a stale entry). When a backend IS configured but temporarily
  unavailable (circuit breaker open / still connecting), they now return `false`
  — a Redis brownout no longer reports a revoked-credential invalidation as
  successful. New `isBackendConfigured()` distinguishes the two.

## Path / line / verdict table

| Path | Symbol | Before | After | Verdict |
|---|---|---|---|---|
| `lib/cache/client.ts` | `del` | swallowed backend failure, `Promise<void>` | best-effort wrapper over `delConfirmed` (unchanged for existing callers) | kept (best-effort by design) |
| `lib/cache/client.ts` | `delConfirmed` (new) | — | `Promise<boolean>`, `false` on rejected backend delete | fail-closed signal |
| `lib/cache/client.ts` | `delPattern` | partial sweep returned as complete, `Promise<void>` | best-effort wrapper over `delPatternConfirmed` | kept (best-effort) |
| `lib/cache/client.ts` | `delPatternConfirmed` (new) | — | `false` when runaway-guard left keys behind | fail-closed signal |
| `lib/cache/service-cache.ts` | `invalidateCache` | `catch → return` (fabricated success) | throws `CacheInvalidationError` on unconfirmed delete | FIXED (J1) |
| `lib/cache/service-cache.ts` | `invalidateCachePattern` | `catch → return` | throws on thrown/incomplete sweep | FIXED (J1) |
| `lib/cache/service-cache.ts` | `invalidateCacheBatch` | fire-all, ignore failures | `allSettled` + throw naming failed keys | FIXED (J1) |
| `lib/services/api-keys.ts` | `invalidateCache` | discarded both `cache.del` results | throws if validation OR inference delete unconfirmed | FIXED (J1) |
| `lib/services/inference-auth-cache.ts` | `invalidateInferenceAuthContextByKeyHash` | discarded `cache.del` result | returns confirmation boolean | FIXED |
| `lib/services/inference-auth-cache.ts` | `invalidateInferenceAuthContextsByKeyHashes` | fire-all, ignore | throws on any unconfirmed delete (ban/deactivate fail closed) | FIXED (J1) |
| `lib/cache/client.ts` | `delConfirmed`/`delPatternConfirmed` (circuit-open) | returned `true` when circuit open over a configured backend | returns `false` when configured-but-unavailable (new `isBackendConfigured()`) | FIXED (codex P1) |
| `lib/services/inference-billing-fast-path.ts` | uncollected-debit user IAC eviction | `void` background call assumed never-throwing old contract | explicit `.catch` + structured log; org hint already invalidated | FIXED (J5) |

## Focused tests

New:
- `lib/cache/service-cache.invalidate.test.ts` — confirmed/unconfirmed/thrown
  delete for `invalidateCache`, incomplete/thrown pattern sweep for
  `invalidateCachePattern`, batch attempts-every-key + reports failed keys +
  empty-input no-op.
- `lib/cache/del-confirmed.test.ts` — `delConfirmed`/`delPatternConfirmed`
  no-backend-configured → `true` vs configured-but-unavailable (circuit open) →
  `false` (fail closed).
- `lib/services/api-keys.invalidation.test.ts` — both deletes confirmed →
  resolves; validation-cache OR inference-auth-context delete unconfirmed →
  throws; `delete()` aborts BEFORE the DB row is removed on failed invalidation;
  confirmed invalidation lets the DB delete proceed; `invalidateInferenceContextForUser`
  unconfirmed fan-out throws (ban fails closed) / all-confirmed resolves.
- `lib/services/inference-billing-fast-path.test.ts` — failed debit still
  invalidates the org balance hint and contains a rejected background user-IAC
  invalidation without surfacing an unhandled rejection.

```
$ bun test packages/cloud/shared/src/lib/cache/del-confirmed.test.ts packages/cloud/shared/src/lib/cache/service-cache.invalidate.test.ts
 14 pass
 0 fail

$ bun test packages/cloud/shared/src/lib/services/api-keys.invalidation.test.ts
 8 pass
 0 fail

$ bun test packages/cloud/shared/src/lib/services/inference-billing-fast-path.test.ts
 29 pass
  0 fail
```

## Verification

- `bunx @biomejs/biome check <touched files>` → clean (no fixes applied).
- `bun run audit:error-policy-ratchet` → `no new fallback-slop in touched files` (EXIT 0).
- `bun run --cwd packages/cloud/shared typecheck` → nonzero from pre-existing
  transitive `../../app-core/**` auth-alias diagnostics; filtered check for
  `cache/client|cache/service-cache|api-keys|inference-auth-cache|inference-billing-fast-path`
  produced no touched-file diagnostics.
- `git diff --check origin/develop...HEAD && git diff --check` → clean.

## Structured log examples (changed runtime failure paths)

- `invalidateCache` unconfirmed: `logger.error("[Cache] Invalidation not confirmed for <key>")` then throw.
- `invalidateCachePattern` incomplete: `logger.error("[Cache] Pattern invalidation incomplete for <pattern>")` then throw.
- `apiKeysService.invalidateCache` unconfirmed: `logger.error("[ApiKeys] API key cache invalidation not confirmed", { shortHash, unconfirmed: [...] })` then throw.
- `inference-billing-fast-path` user eviction failure:
  `logger.error("[InferenceBilling] failed to invalidate user inference auth context", { organizationId, userId, requestId, error })`.

## Evidence types (mandate)

- UI screenshots — N/A (no client surface touched).
- Model trajectories — N/A (no model-backed endpoint touched).
- Audio — N/A.
- DB row / migration artifacts — N/A (no schema/migration change; behavior change
  is at the cache-invalidation boundary, proven by unit tests including the
  fail-closed ordering that gates the DB `delete`).
