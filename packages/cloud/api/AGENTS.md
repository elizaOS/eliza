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
  dedicated-agent-proxy.ts Unified cloud-token auth + proxy for DEDICATED (container)
                           agents reachable at <agentId>.elizacloud.ai/*. Validates the
                           cloud session, confirms org ownership, then swaps the cloud
                           token for the container's ELIZA_API_TOKEN before proxying
                           over the tailnet. Imported lazily from index.ts.
  worker-polyfills.ts      MessagePort/MessageChannel/FinalizationRegistry shims for
                           `wrangler dev` (workerd) module init.
  _generate-router.mjs     Codegen: walks the package for route.ts/route.tsx leaves and
                           emits _router.generated.ts. Next.js App-Router path mapping
                           ([id] -> :id, [...slug] -> splat, (group) dropped).
  _router.generated.ts     GENERATED — do not hand-edit. mountRoutes(app) wires every
                           route. Re-run `bun run codegen` after adding/removing a route.
  middleware/              auth.ts (global auth gate + public-path allowlist),
                           org-membership.ts.
  services/                audit-dispatcher-singleton.ts, audit-events.ts (auth_events sink).
  queue/                   stripe-event.ts, types.ts (Cloudflare Queue consumers).
  steward/embedded.ts      Embedded Steward (auth provider) handler, mounted at /steward*.
  lib/mcp/                 mcps-transport-gateway.ts (createMcpsTransportApp factory).
  lib/apps-deploy-gate.ts  Gate logic for app deploy triggers; used by bootstrap-app.ts.
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

Path-alias note: `@/lib/*`, `@/db/*`, `@/types/*`, `@/billing/*` resolve into `../shared/src/...` (see `tsconfig.json`). `@/api/*` is this package root and `@/api-app/*` is `./src/*`. So an import of `@/lib/auth/workers-hono-auth` is cloud-shared code, not local.

## Key surface

- `index.ts` default export `{ fetch, scheduled }` — the Worker contract Cloudflare invokes.
- `bootstrap-app.ts` `createApp(): Hono<AppEnv>` — called by `index.ts`; the e2e harness boots through `src/index.ts`.
- `src/_router.generated.ts` `mountRoutes(app)` — generated; mounts all 580 route apps.
- `AppEnv` / `Bindings` / `Variables` types come from `@/types/cloud-worker-env` (in cloud-shared) — `Bindings` enumerates every env var/binding the Worker reads.
- Each `route.ts` default-exports a `new Hono<AppEnv>()` instance.

## Commands

```bash
bun run --cwd packages/cloud/api dev            # wrangler dev (local Worker)
bun run --cwd packages/cloud/api dev:full       # dev + local control plane
bun run --cwd packages/cloud/api codegen        # regen src/_router.generated.ts
bun run --cwd packages/cloud/api build          # tsc --noEmit (type-only)
bun run --cwd packages/cloud/api typecheck      # tsgo --noEmit
bun run --cwd packages/cloud/api lint           # biome check .
bun run --cwd packages/cloud/api lint:fix       # biome check --write .
bun run --cwd packages/cloud/api test           # bun test __tests__
bun run --cwd packages/cloud/api test:audit     # route coverage audit
bun run --cwd packages/cloud/api test:e2e       # batched e2e (test/e2e/)
bun run --cwd packages/cloud/api deploy         # wrangler deploy --env production
bun run --cwd packages/cloud/api agent:build    # build the cloud agent container image
```

`dev`/`agent:build` shell out to `packages/scripts/cloud/admin/dev/*.mjs` (outside this package).

## Config / env vars

Worker bindings and env vars are declared in `wrangler.toml` and typed by `Bindings` in `@/types/cloud-worker-env` (cloud-shared). Local dev reads `.dev.vars`; both `.dev.vars` and the `.dev.vars.example` reference file are gitignored (`.gitignore` `.dev.vars.*`). `bun run dev` regenerates `.dev.vars` from repo `.env`/`.env.local` via `packages/scripts/cloud/admin/sync-api-dev-vars.ts`.

Representative bindings (see `Bindings` for the full set): `DATABASE_URL` (Railway Postgres in cloud, reached from the Worker via the `HYPERDRIVE` binding; PGlite locally), `BLOB` (R2), `BITROUTER_API_KEY` / `BITROUTER_BASE_URL` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `CEREBRAS_API_KEY` / `AI_GATEWAY_API_KEY`, `ELEVENLABS_API_KEY`, `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`, `STEWARD_API_URL`, `JWT_SIGNING_KEY_ID` / `JWT_SIGNING_PRIVATE_KEY` / `JWT_SIGNING_PUBLIC_KEY`, `R2_PUBLIC_HOST`. Stripe/crypto webhook secrets are read by their respective route handlers.

## How to extend

Add an endpoint:
1. Create `<resource>/<path>/route.ts` (use `[id]` dirs for params, `(group)` for non-path grouping). Start the file with `import { Hono } from "hono"; const app = new Hono<AppEnv>();`, attach handlers (`app.get("/", ...)`), and `export default app`.
2. Import context types from `@/types/cloud-worker-env`; use `@/lib/...` helpers from cloud-shared for db/auth/providers — do not reimplement them here.
3. If the endpoint must be reachable without a session, add its prefix to `publicPathPrefixes` in `src/middleware/auth.ts` (otherwise the global auth gate 401s it).
4. Run `bun run --cwd packages/cloud/api codegen`. If a file is left Next-shaped (no `from "hono"`), codegen exits non-zero and lists it. Re-running is idempotent; never hand-edit `_router.generated.ts`.

## Conventions / gotchas

- `_router.generated.ts` is generated. Editing it by hand is lost on the next codegen run; the route tree is the source of truth.
- `index.ts` must stay thin. Anything heavy belongs in `bootstrap-app.ts`/routes so it loads lazily — eager work at module top level risks Cloudflare startup error 10021.
- `/api/health` is answered directly in `index.ts` (never boots the full app) — keep it dependency-free.
- The global auth middleware allowlists public paths in `middleware/auth.ts`; programmatic auth (`X-API-Key`, `Bearer eliza_*`) passes through and is validated per-route, not by the gate.
- `src/stubs/*` exist because workerd lacks some node-only deps; they are wired via `wrangler.toml` aliases/`[define]`, not by direct import. Don't import node-only modules in route code.
- Special-cased routes registered manually in `bootstrap-app.ts` (root `/`, `/steward*`, blooio/bluebubbles webhooks, legacy birdeye 308 redirect, jwks) bypass the codegen tree — keep that list in sync when touching those surfaces.
- This is the only `@elizaos/*` package with no published consumers; treat `wrangler.toml` + `index.ts` as the contract.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — cloud backend / security:**
- Real request → response traces against the local cloud stack (`bun run cloud:mock`) hitting real endpoints, plus the structured backend logs.
- The **DB state** the change produced/changed (Drizzle rows), billing/usage records, and migration up **and** down.
- Auth/role-gating and multi-tenant isolation proven by test, including the denied-access paths (see #9853/#9948) — not assumed.
- The agent trajectory for any model-backed endpoint.
<!-- END: evidence-and-e2e-mandate -->
