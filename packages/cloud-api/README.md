# `@elizaos/cloud-api`

The Eliza Cloud HTTP API. Runs on Cloudflare Workers with Hono routing. Backs everything the [Cloud track](../docs/tracks/cloud/overview.mdx) describes: auth, app registration, inference routing, container deploys, billing, domains, MCP, A2A.

## Layout

```
agents/        Agent CRUD + lifecycle
apps/          App registration (appId), versioning
auth/          OAuth (Google, Discord, X), API keys
billing/       Credits, Stripe, auto-renewal
containers/    Hosted container deploys
domains/       Custom domains, TLS
inference/     Routed model calls
llm/           Provider routing policy
mcp/           Hosted MCP endpoints
a2a/           Agent-to-agent protocol
analytics/     Usage, cost, error breakdowns
admin/         Internal admin ops
src/lib/       Database, MCP bridge, cron fanout
src/middleware/ Auth, rate limit, observability
src/steward/   Internal JWT provisioning
```

## Entry

`wrangler.toml` at the package root pins the Worker config. Routes mount under `/v1/<resource>/`. See per-resource subdirectories for handlers.

## Local dev

```bash
cd packages/cloud-api
bun install
bun run dev          # wrangler dev
```

Requires Cloudflare account binding + secrets to talk to live services.

## Docs

User-facing API documentation lives at the [Cloud track](../docs/tracks/cloud/overview.mdx) and its sub-pages (`auth`, `apps`, `inference`, `containers`, `billing`, `domains`).
