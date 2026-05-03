# Cloudflare Workers adapter — changelog

A self-contained, additive port of the Steward API to Cloudflare Workers.
The existing Bun (`packages/api/src/index.ts`) and PGLite
(`packages/api/src/embedded.ts`) entry points are unchanged. The new
`packages/api/src/worker.ts` shares the Hono app via the new
`packages/api/src/app.ts` extraction.

This branch (`cloudflare-workers-adapter`) is **not** pushed. The user
chooses PR vs fork separately.

## Per-commit changelog

Each commit is small and PR-shaped on its own.

| Commit            | Subject                                                    |
| ----------------- | ---------------------------------------------------------- |
| `cf:` add workers entry | Extract `app.ts`; add `worker.ts`; index.ts unchanged at runtime |
| `cf:` wrangler.toml + nodejs_compat | Wrangler config with `nodejs_compat`, env vars, secret list |
| `cf:` pluggable db driver — neon-http for workers | DATABASE_DRIVER selects `postgres-js`/`neon-http`; `createDbForRequest()` |
| `cf:` getSql() neon-http variant | tagged-template parity; `@cloudflare/workers-types` + wrangler devDeps |
| `cf:` pluggable redis client — upstash for workers | REDIS_DRIVER selects `ioredis`/`upstash`; ioredis-shaped adapter |
| `cf:` move siwe nonce + rate-limit log to storage backend | SIWE/SIWS nonces via StoreBackend; drop in-memory Maps + setInterval |
| `cf:` gate runtime migrations on SKIP_MIGRATIONS | New `migrate:neon` script; `packages/db/CLOUDFLARE.md` |
| `cf:` confirm node:crypto under nodejs_compat | Audit notes inline at each import site |
| `cf:` isolate pglite imports from worker entry | Tree-shake guard rails for the worker bundle |
| `cf:` workers build green | `wrangler dry-run` succeeds at 949 KiB gzipped |
| `cf:` docs — cloudflare deployment guide | This file + `packages/api/CLOUDFLARE.md` |
| `cf:` pr split plan | (this file) |

## Pluggable-driver approach

Both database and redis adapters are selected via env var and live
behind a unified type. This keeps the Bun and PGLite paths unchanged
while making the Workers path a one-flag flip:

- `DATABASE_DRIVER=postgres-js` (default) | `neon-http`
- `REDIS_DRIVER=ioredis` (default) | `upstash`

The `@stwd/db` and `@stwd/redis` packages each grew a per-request helper
(`createDbForRequest`, `createUpstashIoredisAdapter`) and a unified
type (`Database`, `IoredisLike`). Existing call sites in
`packages/api`, `packages/auth`, `packages/proxy` did not need to
change.

## How to switch a Bun deployment to Workers

1. Provision Neon + Upstash. Apply migrations:
   ```bash
   cd packages/db
   DATABASE_URL="postgres://...neon.tech/db?sslmode=require" bun run migrate:neon
   ```
2. From `packages/api`, set the secret list (see
   `packages/api/CLOUDFLARE.md`):
   ```bash
   wrangler secret put DATABASE_URL
   wrangler secret put KV_REST_API_URL
   wrangler secret put KV_REST_API_TOKEN
   wrangler secret put STEWARD_SESSION_SECRET
   wrangler secret put STEWARD_MASTER_PASSWORD
   # ...etc, see the full list
   ```
3. Deploy:
   ```bash
   bunx wrangler deploy --env production
   ```

The Bun entry continues to work for any operator that prefers a
long-lived process. Just don't set `DATABASE_DRIVER`/`REDIS_DRIVER` (or
explicitly set them to `postgres-js`/`ioredis`) and the existing
behavior is preserved.

## Open questions for upstream Steward maintainers

These are worth surfacing as GitHub issues if/when this branch turns
into PRs:

1. **`@stwd/db` getDb() return-type cast.** The unified return type uses
   an `as unknown as ReturnType<typeof createDb>["db"]` cast at the
   `getDb()` boundary. The schema is identical for both
   postgres-js/neon-http drivers so this is correct, but a fully-typed
   approach would refactor consumers to accept the union directly.
   Acceptable today; flag for future refactor.

2. **Dropping the in-memory `_authRateLimitStore` fallback.** The Bun
   entry no longer keeps an in-memory fallback for auth rate limiting.
   The platform (Cloudflare/ALB), the global per-IP rate-limit middleware
   in `index.ts`, and the Redis sliding window all still apply. If a
   maintainer prefers a stricter posture, swap the soft-fail in
   `checkAuthRateLimit` for a hard 503.

3. **Upstash `scan` semantics.** `policy-cache.ts:80`'s tag-invalidation
   relies on `SCAN MATCH`. Upstash REST supports `scan` with `match`,
   but the cursor behavior under load may differ from a single-shard
   ioredis. If observed cache-bleed at scale, switch to a per-tenant
   manifest key (one set of tracked policy keys per tenant; replace the
   scan with an explicit DEL list).

4. **`createPublicKey` / ed25519 verify on Workers.** Under
   `nodejs_compat` (GA Sept 2024) workerd ships X25519/Ed25519 support.
   We trust this in code today. If any deploy fails the SIWS path,
   swap to `tweetnacl` (`nacl.sign.detached.verify`) — about 2 KiB,
   zero deps.

5. **Cron / scheduled work.** The Workers entry has no `scheduled()`
   handler. If Steward gains anything that needs a cron (e.g. expired
   token cleanup, webhook retry sweep), add it to `worker.ts` and use
   Cloudflare Cron Triggers — do not rely on `setInterval`.

6. **PGLite tree-shaking.** The pglite re-exports in `@stwd/db/index.ts`
   are pure ESM, so wrangler/esbuild correctly tree-shakes them out of
   the worker bundle today. If a future change adds top-level side
   effects to `pglite.ts`, move those re-exports to a dedicated
   `@stwd/db/pglite` subpath instead. Inline comment in `index.ts`
   warns about this.

## Suggested upstream PR split

Order matters — PRs 2 and 3 unlock the others. PR 1 alone gets the
worker file in but the deploy won't actually work until 2 and 3 land.

| # | Title                                              | Risk    | Files                                                      |
| - | -------------------------------------------------- | ------- | ---------------------------------------------------------- |
| 1 | `app.ts` extraction + `worker.ts` + `wrangler.toml` | low (mechanical) | `packages/api/src/{app,index,worker}.ts`, `packages/api/wrangler.toml`, `packages/api/{package.json,tsconfig.json}` |
| 2 | Pluggable DB driver (`postgres-js` \| `neon-http` \| `pglite`) | medium (adds dep, changes return type) | `packages/db/src/{client,index}.ts`, `packages/db/package.json`, `packages/db/CLOUDFLARE.md` |
| 3 | Pluggable Redis client (`ioredis` \| `upstash`) | medium (adds dep, IoredisLike facade) | `packages/redis/src/{client,upstash-adapter,index}.ts`, `packages/redis/package.json`, `packages/api/src/middleware/redis.ts` |
| 4 | SIWE nonce + auth rate-limit → storage backend | low | `packages/api/src/routes/auth.ts` |
| 5 | `SKIP_MIGRATIONS` gating + `migrate:neon` script | low (already gated, just docs + script) | `packages/db/package.json`, `packages/db/CLOUDFLARE.md` |
| 6 | Docs: `packages/api/CLOUDFLARE.md` + this file | docs-only | `packages/api/CLOUDFLARE.md`, `CHANGES-CLOUDFLARE.md` |

PR 4 is technically independent of the Workers port — it removes a
single-process assumption and is a healthy change for any multi-instance
Bun deployment too.

### Quick-reference branch state

```
$ git log --oneline cloudflare-workers-adapter ^develop
cf: pr split plan
cf: docs — cloudflare deployment guide
cf: workers build green
cf: isolate pglite imports from worker entry
cf: confirm node:crypto under nodejs_compat
cf: gate runtime migrations on SKIP_MIGRATIONS
cf: move siwe nonce + rate-limit log to storage backend
cf: pluggable redis client — upstash for workers
cf: getSql() neon-http variant
cf: pluggable db driver — neon-http for workers
cf: wrangler.toml + nodejs_compat
cf: add workers entry packages/api/src/worker.ts
```

Each commit corresponds to one row in the PR split table above (with
the `pr split plan` and `docs` commits combinable into PR 6).

