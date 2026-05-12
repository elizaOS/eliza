# Eliza Cloud V2

## Stack
- **Runtime**: Bun
- **Framework**: Next.js 15 (App Router)
- **Database**: PostgreSQL + Drizzle ORM
- **Deployment**: Cloudflare Workers (API) + Cloudflare Pages (frontend)
- **UI**: React + Tailwind CSS

## Default Cloud Product Assumptions

- Treat Eliza Cloud apps as first-class backend integration units. A typical integration creates an app, stores its `appId`, configures `app_url` plus allowed origins and redirect URIs, and then uses Cloud APIs for chat, media, agents, billing, analytics, domains, and user tracking.
- If an external app needs user sign-in, prefer the existing app auth flow (`app_id` + `redirect_uri`) instead of inventing a separate identity system. App users logging in through the app can use Eliza Cloud as the backend.
- If a feature needs server-side execution, prefer the existing containers product before inventing separate hosting. This repo already supports Docker image push + container deployment flows, status polling, logs, metrics, and container URLs/domains.
- Current app monetization in this repo is driven by `monetization_enabled`, `inference_markup_percentage`, `purchase_share_percentage`, `platform_offset_amount`, and creator earnings tracking. Users pay app-specific credits and creators can accumulate redeemable earnings.
- Some older docs still describe generic per-request/per-token app pricing. For implementation work, prefer the current schema, API, and UI code in this repo when the prose docs drift.

## API auth, CORS, and errors

See [docs/api-authentication.md](docs/api-authentication.md) for cookie vs API key vs Bearer vs wallet auth, CORS sources, rate-limit presets, and the canonical JSON error shape. For **why** session-only vs programmatic routes are split (edge + handlers), see [docs/auth-api-consistency.md](docs/auth-api-consistency.md). For **why** OpenRouter vs legacy `xai/` / `mistral/` model and provider spellings are normalized together in billing and usage SQL, see [docs/openrouter-model-id-compatibility.md](docs/openrouter-model-id-compatibility.md).

## Commands
```bash
bun install          # Install dependencies
bun run dev          # Start dev server
bun run build        # Production build
bun run db:migrate   # Apply database migrations
bun run db:generate  # Generate migration from schema
bun run db:studio    # Open Drizzle Studio
```

## Database Migrations

**Never use `db:push` - it's removed. All schema changes go through migrations.**

### Schema Change Workflow
1. Edit schema in `packages/db/schemas/`
2. `bun run db:generate`
3. Review SQL in `packages/db/migrations/`
4. `bun run db:migrate`
5. Commit both schema + migration

### Custom Migrations
```bash
npx drizzle-kit generate --custom --name=descriptive_name
```

### Rules
- No `CREATE INDEX CONCURRENTLY` (runs in transaction)
- Use `IF NOT EXISTS` / `IF EXISTS`
- Never edit applied migrations
- See `docs/database-migrations.md` for details

## Project Structure
```
app/               # Next.js App Router pages
packages/
  lib/             # Business logic, services
  db/
    schemas/       # Drizzle schema definitions
    migrations/    # SQL migration files
    repositories/  # Data access layer
  components/      # React components
  ui/              # Shared UI component library
  tests/           # Test suites
  types/           # Shared TypeScript generic types
  scripts/         # CLI utilities
  infra/           # Infrastructure logic
  config/          # Shared settings
```
