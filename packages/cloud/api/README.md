# @elizaos/cloud-api

The Eliza Cloud HTTP API. It runs as a Cloudflare Worker with [Hono](https://hono.dev) routing and backs the managed services behind Eliza Cloud: authentication, app and agent registration, inference routing, billing, MCP and A2A endpoints, custom domains, and container deploys.

It is deployed standalone (`wrangler deploy`) rather than imported by other packages. Most shared logic — the database client, auth, AI-provider routing, billing, and cron — lives in `@elizaos/cloud-shared`; this package owns the Worker entrypoint, the route tree, and the codegen that mounts it.

## How routing works

Endpoints are file-based, mirroring the Next.js App Router, but each leaf is a small Hono app. A `route.ts` at `v1/models/route.ts` is served at `/api/v1/models`. Dynamic segments use `[id]` directories and grouping uses `(group)` directories.

A codegen step (`src/_generate-router.mjs`) walks the package, finds every `route.ts` / `route.tsx`, and writes `src/_router.generated.ts`, which exports `mountRoutes(app)`. Every Hono-shaped leaf is mounted when it imports from `hono`, or imports the shared `createMcpsTransportApp` factory (the `mcps/*/[transport]` routes). Any other leaf fails generation before the generated files are written. Run `bun run codegen` after adding or removing a route.

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
cd packages/cloud/api
bun install
bun run dev          # wrangler dev (writes .dev.vars from repo .env/.env.local)
```

`.dev.vars.example` is a reference template; `.dev.vars` and `.dev.vars.example` are both gitignored. Real secrets belong in the repo `.env.local`. Talking to live services (Railway Postgres, R2, Stripe, providers) requires the corresponding bindings/secrets.

## Verify deployment routing

From the repository root, verify that the development API answers with its own environment:

```bash
node packages/cloud/scripts/verify-environment-routing-cli.mjs --environment development --require-beacon
```

The expected endpoint is `api-development.eliza.app`, matching the development infrastructure API origin. The check fails until that endpoint is deployed and reachable. Use `--environment staging`, `--environment production`, or `--environment all` for the other declared routes. A response from another tier always fails, including when unreachable origins are temporarily permitted during a rollout.

## Scripts

- `bun run dev` — local Worker via wrangler
- `bun run codegen` — regenerate `src/_router.generated.ts`
- `bun run check:router-contract` — verify generated mount parity and required live routes
- `bun run build` — type-only compilation
- `bun run typecheck` — types, router contract, and Worker bundle dry-run
- `bun run lint` / `bun run lint:fix` — Biome
- `bun run test` / `bun run test:e2e` — unit and e2e suites
- `bun run deploy` — `wrangler deploy --env production`

## Agent docs

`CLAUDE.md` / `AGENTS.md` in this directory describe the package for AI coding agents (where code lives, how to extend it).

## Independent native App Auth clients

`ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON` optionally registers additional native clients.
It is a server-owned JSON array of `{clientId, appId, redirectUri, enabled}` records.
Client IDs, app UUIDs and canonical HTTPS return URLs must be unique, including
against the existing `ai.elizaos.app` registration. Unknown and disabled clients
fail closed; malformed additional configuration does not change the legacy client.
The global mobile-auth enable switch and environment binding still apply.

Before enabling a client, provision its own active, approved app with an active
owner/organization, an exact allowed callback, and no live generated application
API key. Use separate registrations in staging and production. Validate the public
`/api/v1/app-auth/mobile/config` response for that client/environment/return URL
before shipping. The app UUID and server secrets must not be included in the
native configuration. Retain the existing S256 grant, inactive exchange, durable
receipt acknowledgment, self-revocation and account recovery contracts. `cloud:user`
is the existing broad user/organization capability, not a narrower permission claim.
