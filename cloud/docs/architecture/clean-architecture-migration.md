# Clean Architecture migration — ADR

**Status**: in progress (Phase A + B Hono-scope landed; Phase C–F planned)
**Branch**: `refactor/clean-architecture`
**Plan**: `~/.claude/plans/met-toi-en-mode-tidy-squirrel.md` (local)

## Context

The Cloud API Worker had a critical bug: `CacheClient` was a module-level
singleton whose lazy-opened Redis socket got bound to the first request's
I/O context on Cloudflare Workers, causing `Cannot perform I/O on behalf
of a different request` on subsequent requests. A May 2 hotfix
(`CACHE_ENABLED="false"`) disabled cache globally, killing perf
everywhere; SIWE was further patched in PR #7324 with a per-request
bypass.

Rather than just fix the cache singleton (which would leave the rest of
the codebase architecturally messy), we chose to do a proper Clean
Architecture refactor that addresses the root cause and produces a
maintainable layered codebase.

## Layering target

```
┌────────────────── Transport ──────────────────┐
│  apps/api/**/route.ts                          │
│  Thin handlers: c.var.deps.<useCase>.execute() │
└───────────────────┬───────────────────────────┘
                    │
┌──────────────── Application ──────────────────┐
│  packages/lib/application/<aggregate>/         │
│  Use case classes (1 command = 1 class)        │
│  Constructor DI: takes domain interfaces       │
│  Pure business logic — no DB/cache/framework   │
└───────────────────┬───────────────────────────┘
                    │
┌────────────────── Domain ─────────────────────┐
│  packages/lib/domain/<aggregate>/              │
│  Entities + Repository interfaces              │
│  No imports from infrastructure                │
└───────────────────┬───────────────────────────┘
                    │
┌─────────── Infrastructure (composition) ──────┐
│  packages/lib/infrastructure/db/               │
│   Postgres*Repository implements domain        │
│   interfaces; delegates to packages/db/        │
│   repositories/* (existing pure-DB layer)      │
│  packages/lib/infrastructure/cache/            │
│   Cached*Repository decorators that own cache  │
│   keys + TTLs + invalidation per-aggregate     │
└───────────────────┬───────────────────────────┘
                    │
┌─────────── Composition root ──────────────────┐
│  apps/api/src/composition/build-container.ts   │
│  buildContainer(env) → CompositionContext      │
│  Per-request: fresh use-case bundle on c.var   │
└────────────────────────────────────────────────┘
```

**Layering rule**: Transport → Application → Domain. Infrastructure
implements Domain interfaces. Domain depends on nothing.

## Architectural concession (validated 2026-05-03)

The clean DI / `c.var.deps` pattern applies cleanly to the **Hono request
scope**. It does NOT apply naturally to:

- **elizaOS plugin runtime services** — e.g. `N8nCredentialBridge`
  registered in `services: [...]` and instantiated by the elizaOS runtime
  via reflection. The runtime expects self-contained services.
- **Background flows / non-Hono callers** — `auth.ts` request-based
  helpers, `steward-sync.ts` sync flow, `actions/dashboard.ts` server
  actions. These predate Hono and operate on raw `Request`.
- **Multi-context service singletons** — `apps/cli-auth-sessions/
  google-search/eliza-app-user-service/managed-eliza-config`. Used from
  both Hono routes AND elizaOS runtime AND cron — runtime-agnostic
  singletons.

For these, the legacy `apiKeysService` (and similar singletons) survive
as their dependency on the new architecture. They are **not** clean DI
but they continue to work because:

1. The singleton imports the same `cache` instance — coherent cache state
   between the Hono path (decorator-based) and the singleton path
   (direct `cache.get/set`). Same keys, same TTLs.
2. `ApiKeysService.{validateApiKey,create,...}` will be migrated in a
   later Phase F to delegate internally to the use cases — keeping the
   singleton's public API but routing through the new infrastructure.

Phase F is scoped separately and not part of this PR.

## Phase plan

| Phase | Scope | Status |
|---|---|---|
| A | Layered skeleton (domain/, application/, infrastructure/, composition root, AppEnv.Variables.deps typing, middleware) | ✅ commit `43cd138af8` |
| B.1 | ApiKey aggregate foundation (domain entity + repo interface + postgres adapter + cached decorator + 8 use cases + buildContainer wiring) | ✅ commit `4039837a95` |
| B.2.a | Migrate 12 routes (`apps/api/**/route.ts`) to `c.var.deps.<useCase>.execute(...)` | ✅ commits `ff3acb0937` + `c5eab0f166` |
| B.2.b | Migrate `packages/lib/auth/workers-hono-auth.ts` (Hono c-taking helpers); drop dead `app-auth.ts` | ✅ commit `4d288c4753` |
| B.2.c | Drop dead `buildContext` path in `user-context.ts` (only `createSystemContext` is consumed) | ✅ commit `93ae87d93b` |
| C | 11 aggregates (Organization, User, App, Character, OAuth split, Affiliate, UserMcp+UserMetrics, Credit, Agent, misc) | 🟡 planned |
| D | `CacheClient` per-request via constructor; reactivate `CACHE_ENABLED=true`; roll back PR #7324 SIWE bypass | 🟡 planned |
| E | Final cleanup; promote `domain/application/infrastructure/` to top-level packages with their own tsconfig path aliases; ADR finalization | 🟡 planned |
| F (deferred) | Migrate elizaOS plugin runtime services + multi-context service singletons + auth.ts cascade off `apiKeysService`. Out of scope for this PR. | ⏸ deferred |

## What's invariant after Phase B

- Cache state coherence: any request that hits the cache via either path
  (new decorator-based `c.var.deps.validateApiKey.execute(...)` or legacy
  `apiKeysService.validateApiKey(...)`) reads/writes under the same
  `siwe:nonce:{hash16}:v1` cache key with `CacheTTL.apiKey.validation`.
- `apiKeysService` is alive but in graceful transition: routes use it via
  use cases; non-Hono runtime uses it directly. No dual cache writes.

## What's still off

- `CACHE_ENABLED="false"` remains in wrangler.toml (Phase D will flip it).
- PR #7324 SIWE bypass still in place (Phase D will roll back).
- All other aggregates still on legacy services.

## File-level reuse

| Existing | New layer | Relationship |
|---|---|---|
| `packages/db/repositories/api-keys.ts` (`apiKeysRepository`) | `packages/lib/infrastructure/db/api-key/postgres-api-key-repository.ts` | adapter delegates |
| `packages/lib/cache/keys.ts` (`CacheKeys.apiKey.validation`) | `packages/lib/infrastructure/cache/api-key/cached-api-key-repository.ts` | decorator owns the same key |
| `packages/lib/cache/redis-factory.ts` (`buildRedisClient`) | unchanged — used by `CacheClient` | per-request Redis (Phase D) |
| `packages/lib/runtime/cloud-bindings.ts` (`runWithCloudBindingsAsync`) | unchanged — middleware chain | env propagation |

## References

- CF Workers cross-request I/O isolation: https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/#considerations
- Original singleton bug commit: `3c00f8e62a` (2026-05-02 hotfix that set `CACHE_ENABLED=false`)
- SIWE hotfix: PR #7324
- App-URL Workers env: PR #7327
