# @elizaos/cloud-shared

Single backend package for Eliza Cloud. See [CLAUDE.md](./CLAUDE.md) for the package layout, commands, and architecture rules — this file covers product/business assumptions only.

## Stack
- **Runtime**: Bun (server), browser (only what cloud-frontend imports)
- **API consumer**: `@elizaos/cloud-api` — Hono on Cloudflare Workers
- **UI consumer**: `@elizaos/cloud-frontend` — Vite + React 19, deployed to Cloudflare Pages
- **Database**: PostgreSQL via Drizzle ORM (Neon in prod, PGlite locally)

## Default Cloud Product Assumptions

- Treat Eliza Cloud apps as first-class backend integration units. A typical integration creates an app, stores its `appId`, configures `app_url` plus allowed origins and redirect URIs, and then uses Cloud APIs for chat, media, agents, billing, analytics, domains, and user tracking.
- If an external app needs user sign-in, prefer the existing app auth flow (`app_id` + `redirect_uri`) instead of inventing a separate identity system. App users logging in through the app can use Eliza Cloud as the backend.
- If a feature needs server-side execution, prefer the existing containers product before inventing separate hosting. This repo already supports Docker image push + container deployment flows, status polling, logs, metrics, and container URLs/domains.
- Current app monetization in this repo is driven by `monetization_enabled`, `inference_markup_percentage`, `purchase_share_percentage`, `platform_offset_amount`, and creator earnings tracking. Users pay app-specific credits and creators can accumulate redeemable earnings.
- Some older docs still describe generic per-request/per-token app pricing. For implementation work, prefer the current schema, API, and UI code in this repo when the prose docs drift.

## API auth, CORS, and errors

See [docs/api-authentication.md](docs/api-authentication.md) for cookie vs API key vs Bearer vs wallet auth, CORS sources, rate-limit presets, and the canonical JSON error shape. For **why** session-only vs programmatic routes are split (edge + handlers), see [docs/auth-api-consistency.md](docs/auth-api-consistency.md). For **why** OpenRouter vs legacy `xai/` / `mistral/` model and provider spellings are normalized together in billing and usage SQL, see [docs/openrouter-model-id-compatibility.md](docs/openrouter-model-id-compatibility.md).

## Commands, structure, migrations, type-checking

See [CLAUDE.md](./CLAUDE.md) — single source of truth. It covers the flat `src/{billing,db,lib,types}/` layout, subpath exports, drizzle workflow, migration rules, and architecture commandments.
