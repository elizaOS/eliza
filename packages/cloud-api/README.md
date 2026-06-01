# @elizaos/cloud-api

The Eliza Cloud HTTP API. It runs as a Cloudflare Worker with [Hono](https://hono.dev) routing and backs the managed services behind Eliza Cloud: authentication, app and agent registration, inference routing, billing, MCP and A2A endpoints, custom domains, and container deploys.

It is deployed standalone (`wrangler deploy`) rather than imported by other packages. Most shared logic — the database client, auth, AI-provider routing, billing, and cron — lives in `@elizaos/cloud-shared`; this package owns the Worker entrypoint, the route tree, and the codegen that mounts it.

## How routing works

Endpoints are file-based, mirroring the Next.js App Router, but each leaf is a small Hono app. A `route.ts` at `v1/models/route.ts` is served at `/api/v1/models`. Dynamic segments use `[id]` directories and grouping uses `(group)` directories.

A codegen step (`src/_generate-router.mjs`) walks the package, finds every `route.ts` / `route.tsx`, and writes `src/_router.generated.ts`, which exports `mountRoutes(app)`. Only leaves that import from `hono` are mounted. Run `bun run codegen` after adding or removing a route.

The Worker entrypoint (`src/index.ts`) answers `/api/health` directly and lazy-loads the full Hono stack (`src/bootstrap-app.ts`) on the first request, keeping cold-start work under Cloudflare's startup CPU budget.

## Layout

```
src/index.ts          Worker entrypoint ({ fetch, scheduled })
src/bootstrap-app.ts  Builds the full Hono app + global middleware
src/_router.generated.ts  Generated route mount table (do not hand-edit)
src/middleware/       Auth gate, API-key permissions, org membership
src/services/         Audit-event dispatcher
src/queue/            Cloudflare Queue consumers (Stripe events)
src/steward/          Embedded Steward auth handler
src/stubs/            workerd stand-ins for node-only deps
<resource>/route.ts   Handlers: v1/, auth/, agents/, billing/, stripe/,
                      mcp/, mcps/, a2a/, analytics/, admin/, training/, …
wrangler.toml         Worker config (bindings, routes, queues, cron)
```

## Local development

```bash
cd packages/cloud-api
bun install
bun run dev          # wrangler dev (writes .dev.vars from repo .env/.env.local)
```

Copy `.dev.vars.example` for reference. Real secrets belong in the repo `.env.local`, not in the tracked template. Talking to live services (Neon, R2, Stripe, providers) requires the corresponding bindings/secrets.

## Scripts

- `bun run dev` — local Worker via wrangler
- `bun run codegen` — regenerate `src/_router.generated.ts`
- `bun run build` / `bun run typecheck` — type-only checks
- `bun run lint` / `bun run lint:fix` — Biome
- `bun run test` / `bun run test:e2e` — unit and e2e suites
- `bun run deploy` — `wrangler deploy --env production`

## Agent docs

`CLAUDE.md` / `AGENTS.md` in this directory describe the package for AI coding agents (where code lives, how to extend it).
