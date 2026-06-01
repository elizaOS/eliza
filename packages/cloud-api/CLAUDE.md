# @elizaos/cloud-api

The Eliza Cloud HTTP API: a Cloudflare Workers app (Hono router) that backs auth, app/agent registration, inference routing, billing, MCP, A2A, domains, and container deploys. Not an elizaOS plugin and not imported by other packages — it is deployed as a standalone Worker (`wrangler deploy`). Most shared logic (DB client, auth, providers, billing, cron) lives in `@elizaos/cloud-shared`; this package owns the Worker entrypoint, the route tree, and the route-mount codegen.

See the root `AGENTS.md` for repo-wide rules (logger-only, ESM, naming, architecture). Conventions below are specific to this package.

## Layout

```
src/
  index.ts                 Worker entrypoint: { fetch, scheduled }. Thin — fast-paths
                           /api/health, then lazy-imports bootstrap-app on first request
                           to stay under Cloudflare's startup CPU budget (error 10021).
  bootstrap-app.ts         createApp(): builds the full Hono<AppEnv> stack — global
                           middleware (cors, secureHeaders, requestId, logger,
                           observability, auth), special-case routes, then mountRoutes().
  worker-polyfills.ts      MessagePort/MessageChannel/FinalizationRegistry shims for
                           `wrangler dev` (workerd) module init.
  _generate-router.mjs     Codegen: walks the package for route.ts/route.tsx leaves and
                           emits _router.generated.ts. Next.js App-Router path mapping
                           ([id] -> :id, [...slug] -> splat, (group) dropped).
  _router.generated.ts     GENERATED — do not hand-edit. mountRoutes(app) wires every
                           route. Re-run `bun run codegen` after adding/removing a route.
  middleware/              auth.ts (global auth gate + public-path allowlist),
                           api-key-permission.ts, org-membership.ts.
  services/                audit-dispatcher-singleton.ts, audit-events.ts (auth_events sink).
  queue/                   stripe-event.ts, types.ts (Cloudflare Queue consumers).
  steward/embedded.ts      Embedded Steward (auth provider) handler, mounted at /steward*.
  lib/mcp/                 mcps-transport-gateway.ts (createMcpsTransportApp factory).
  stubs/                   Build-time stand-ins for node-only deps unavailable in workerd
                           (elizaos-core, ssh2, undici, plugin-sql, plugin-elevenlabs,
                           s3 adapter) — wired via wrangler.toml alias/define.

<resource>/.../route.ts    Route handlers live in top-level resource dirs (NOT under src/):
                           v1/, auth/, agents/, billing/, stripe/, mcp/, mcps/, a2a/,
                           analytics/, admin/, training/, webhooks/, organizations/, etc.
                           Each route.ts exports a Hono app (default export).
.well-known/               jwks.json/route.ts, agent-card.json/route.ts.
wrangler.toml              Worker config: bindings, routes, aliases, [define], queues, cron.
__tests__/                 bun test unit suites.
test/                      e2e harness (test/e2e/), coverage/inventory audit scripts.
```

## Route model (read this before adding endpoints)

Routes are file-based, mirroring Next.js App Router, but each leaf is a Hono sub-app. A `route.ts` at `v1/models/route.ts` mounts at `/api/v1/models`. The codegen only mounts leaves whose source imports from `"hono"` (or the `createMcpsTransportApp` factory) — a non-Hono leaf is skipped and falls through to the global 404. `index.ts` lazy-loads the whole stack, so route modules are only evaluated on the first real request.

Path-alias note: `@/lib/*`, `@/db/*`, `@/types/*`, `@/billing/*` resolve into `../cloud-shared/src/...` (see `tsconfig.json`). `@/api/*` is this package root and `@/api-app/*` is `./src/*`. So an import of `@/lib/auth/workers-hono-auth` is cloud-shared code, not local.

## Key surface

- `index.ts` default export `{ fetch, scheduled }` — the Worker contract Cloudflare invokes.
- `bootstrap-app.ts` `createApp(): Hono<AppEnv>` — used by `index.ts` and by tests.
- `src/_router.generated.ts` `mountRoutes(app)` — generated; mounts all 569+ route apps.
- `AppEnv` / `Bindings` / `Variables` types come from `@/types/cloud-worker-env` (in cloud-shared) — `Bindings` enumerates every env var/binding the Worker reads.
- Each `route.ts` default-exports a `new Hono<AppEnv>()` instance.

## Commands

```bash
bun run --cwd packages/cloud-api dev            # wrangler dev (local Worker)
bun run --cwd packages/cloud-api dev:full       # dev + local control plane
bun run --cwd packages/cloud-api codegen        # regen src/_router.generated.ts
bun run --cwd packages/cloud-api build          # tsc --noEmit (type-only)
bun run --cwd packages/cloud-api typecheck      # tsgo --noEmit
bun run --cwd packages/cloud-api lint           # biome check .
bun run --cwd packages/cloud-api lint:fix       # biome check --write .
bun run --cwd packages/cloud-api test           # bun test __tests__
bun run --cwd packages/cloud-api test:audit     # route coverage audit
bun run --cwd packages/cloud-api test:e2e       # batched e2e (test/e2e/)
bun run --cwd packages/cloud-api deploy         # wrangler deploy --env production
bun run --cwd packages/cloud-api agent:build    # build the cloud agent container image
```

`dev`/`agent:build` shell out to `packages/scripts/cloud/admin/dev/*.mjs` (outside this package).

## Config / env vars

Worker bindings and env vars are declared in `wrangler.toml` and typed by `Bindings` in `@/types/cloud-worker-env` (cloud-shared). Local dev reads `.dev.vars` (gitignored); `.dev.vars.example` is the tracked template. `bun run dev` regenerates `.dev.vars` from repo `.env`/`.env.local` via `packages/scripts/cloud/admin/sync-api-dev-vars.ts`.

Representative bindings (see `Bindings` for the full set): `DATABASE_URL` / `DATABASE_URL_UNPOOLED` (Neon Postgres in cloud, PGlite locally), `BLOB` (R2), `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `CEREBRAS_API_KEY` / `OPENROUTER_API_KEY` / `AI_GATEWAY_API_KEY`, `ELEVENLABS_API_KEY`, `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`, `STEWARD_API_URL`, `JWT_SIGNING_KEY_ID` / `JWT_SIGNING_PRIVATE_KEY` / `JWT_SIGNING_PUBLIC_KEY`, `R2_PUBLIC_HOST`. Stripe/crypto webhook secrets are read by their respective route handlers.

## How to extend

Add an endpoint:
1. Create `<resource>/<path>/route.ts` (use `[id]` dirs for params, `(group)` for non-path grouping). Start the file with `import { Hono } from "hono"; const app = new Hono<AppEnv>();`, attach handlers (`app.get("/", ...)`), and `export default app`.
2. Import context types from `@/types/cloud-worker-env`; use `@/lib/...` helpers from cloud-shared for db/auth/providers — do not reimplement them here.
3. If the endpoint must be reachable without a session, add its prefix to `publicPathPrefixes` in `src/middleware/auth.ts` (otherwise the global auth gate 401s it).
4. Run `bun run --cwd packages/cloud-api codegen`. If a file is left Next-shaped (no `from "hono"`), codegen exits non-zero and lists it. Re-running is idempotent; never hand-edit `_router.generated.ts`.

## Conventions / gotchas

- `_router.generated.ts` is generated. Editing it by hand is lost on the next codegen run; the route tree is the source of truth.
- `index.ts` must stay thin. Anything heavy belongs in `bootstrap-app.ts`/routes so it loads lazily — eager work at module top level risks Cloudflare startup error 10021.
- `/api/health` is answered directly in `index.ts` (never boots the full app) — keep it dependency-free.
- The global auth middleware allowlists public paths in `middleware/auth.ts`; programmatic auth (`X-API-Key`, `Bearer eliza_*`) passes through and is validated per-route, not by the gate.
- `src/stubs/*` exist because workerd lacks some node-only deps; they are wired via `wrangler.toml` aliases/`[define]`, not by direct import. Don't import node-only modules in route code.
- Special-cased routes registered manually in `bootstrap-app.ts` (root `/`, `/steward*`, blooio/bluebubbles webhooks, legacy birdeye 308 redirect, jwks) bypass the codegen tree — keep that list in sync when touching those surfaces.
- This is the only `@elizaos/*` package with no published consumers; treat `wrangler.toml` + `index.ts` as the contract.
