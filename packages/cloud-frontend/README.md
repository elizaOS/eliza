# `@elizaos/cloud-frontend`

The Eliza Cloud dashboard. React + Vite + Tailwind. Talks to `@elizaos/cloud-api`.

## What it exposes

- Sign-in, OAuth callback handling, account settings.
- App management — register `appId`, edit redirects, version + publish.
- Inference routing policy — provider priority, fallback chains, rate limits.
- Container deploys — create, scale, logs, lifecycle.
- Billing — credits, top-up, Stripe portal, creator earnings.
- Domains — add, verify, route to apps/containers.
- Analytics — usage, cost breakdown, error rates.
- MCP server registry and A2A endpoints.

## Layout

```
src/                Top-level routes and entry
src/dashboard/      Dashboard panes (apps, agents, billing, etc.)
src/components/     Shared UI primitives
content/            Static content (docs strips, marketing)
functions/          Cloudflare Pages Functions (edge-side helpers)
```

## Local dev

```bash
cd packages/cloud-frontend
bun install
bun run dev          # vite dev server
```

Hit `http://localhost:5173`. The frontend talks to the API at `VITE_CLOUD_API_URL` (default `https://cloud.elizaos.ai`).

## User-facing docs

The dashboard's user-facing flows are documented under the [Cloud track](../docs/tracks/cloud/overview.mdx) in the docs site.
