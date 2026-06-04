# @elizaos/cloud-shared

Shared backend code for Eliza Cloud: billing arithmetic, Drizzle DB schemas/repositories/migrations, server-side service library, transport types, and route/auth helpers.

## Role

Single private workspace package (`@elizaos/cloud-shared`) consumed by the rest of the cloud stack:

- `@elizaos/cloud-api` — Hono API on Cloudflare Workers (imports `lib/`, `db/`, `billing/`, `types/`).
- `@elizaos/cloud-frontend` — Vite + React 19 (Cloudflare Pages); imports only the isomorphic bits (`billing/`, some `types/`).
- `@elizaos/cloud-services/*` and a few plugins.

It was once a workspace root with sub-packages `billing/`, `db/`, `lib/`, `types/`; now collapsed into one package exposed via subpath exports.

## Layout

```
src/
  index.ts                 top barrel — re-exports billing/db/lib/types as namespaces
  billing/                 @elizaos/cloud-shared/billing — pure, isomorphic markup math
    markup.ts              applyMarkup, Twilio SMS billing, USD rounding
    credit-markup.ts       calculateCreditMarkup, platform fee breakdown
    index.ts
  db/                      @elizaos/cloud-shared/db — Drizzle (Neon prod, PGlite local)
    schemas/               ~97 table schemas (apps, agents, billing, containers, ...)
    repositories/          ~66 CQRS repositories (readers/writers split)
    migrations/            generated SQL — never hand-edit applied migrations
    client.ts              DB client; worker-neon-http.ts for Worker runtime
    crypto/  utils/
    index.ts
  lib/                     @elizaos/cloud-shared/lib — SERVER-ONLY services + use-cases
    services/              ~207 service modules (containers, gateways, billing, ...)
    auth.ts auth-anonymous.ts auth-errors.ts   session/API-key/wallet auth
    api/  middleware/  cors/  http/  session/   request-edge helpers
    stripe.ts  pricing.ts  promotion-pricing.ts
    utils/logger.ts        the structured logger used across lib/
    index.ts
  types/                   @elizaos/cloud-shared/types
    cloud-api.ts           API DTO types
    cloud-worker-env.ts    Cloudflare Worker env bindings
    stripe-queue-message.ts
    index.ts
drizzle.config.ts          points at ./src/db/{schemas,migrations}
scripts/messaging-gateway-preflight.mjs   preflight:messaging-gateways
docs/                      WHY docs (auth consistency, provisioning, messaging gateways)
```

Subpath imports: `import { ... } from "@elizaos/cloud-shared/db"`, `".../billing"`, `".../lib/services/<x>"`, `".../types"`. Exports map: `.` `./billing` `./db` `./db/*` `./lib` `./lib/*` `./types` `./types/*` (see `package.json`).

## Key exports

- `src/index.ts` — namespaces: `billing`, `db`, `lib`, `types`.
- `billing/index.ts` — `applyMarkup`, `applyMarkupCents`, `calculateCreditMarkup`, `calculateTwilioSmsBilling`, `roundUsd`, plus `DEFAULT_MARKUP_RATE`, `PLATFORM_MARKUP_MULTIPLIER`, `DEFAULT_PLATFORM_FEE_RATE`, and the `MarkupBreakdown` / `CreditMarkupBreakdown` types.
- `db/index.ts` re-exports a few repositories (`userCharactersRepository`, `dockerNodesRepository`, `voiceImprintsRepository`); most schemas/repositories are imported by their own subpath, e.g. `@elizaos/cloud-shared/db/repositories/apps`.
- `lib/index.ts` — `logger`, container/provisioning helpers (`WarmPoolManager`, `getHetznerContainersClient`, `provisioningJobService`, `elizaSandboxService`), `runWithCloudBindingsAsync`, envelope helpers (`envelope`, `errorEnvelope`).

## Commands

```bash
bun run --cwd packages/cloud-shared typecheck              # tsc --noEmit
bun run --cwd packages/cloud-shared lint                   # biome check
bun run --cwd packages/cloud-shared lint:fix
bun run --cwd packages/cloud-shared test                   # bun test
bun run --cwd packages/cloud-shared db:generate            # drizzle-kit generate
bun run --cwd packages/cloud-shared db:migrate             # migrate-with-diagnostics.ts
bun run --cwd packages/cloud-shared db:migrate:drizzle     # drizzle-kit migrate
bun run --cwd packages/cloud-shared db:studio              # drizzle-kit studio
bun run --cwd packages/cloud-shared db:check-migrations    # drizzle-kit check
bun run --cwd packages/cloud-shared preflight:messaging-gateways
```

`build:linked-workspaces` defers to the repo-root `build:core`; there is no standalone build step here (consumers import `src/` directly).

## Config / env vars

`db/database-url.ts` resolves the Postgres URL: explicit `DATABASE_URL`/`TEST_DATABASE_URL` (Neon in prod) wins; otherwise local (non-CI, non-production) dev falls back to a file-backed PGlite store at `pglite://<cwd>/.eliza/.pgdata` (override the path with `PGLITE_DATA_DIR`/`LOCAL_DATABASE_PATH`; set `DISABLE_LOCAL_PGLITE_FALLBACK=1` to opt out). The `pglite:server` script runs a pglite-socket sidecar so `drizzle-kit` can connect. The `lib/` services read service-specific env (Stripe, Steward session/JWT secrets, BitRouter/provider keys, Telegram/Discord/WhatsApp, Hetzner/container infra, etc.). See `.env.example` for the full set.

## How to extend

- **New table:** add a schema in `src/db/schemas/`, then `bun run --cwd packages/cloud-shared db:generate`, review the SQL in `src/db/migrations/`, run `db:migrate`, commit schema + migration together. Add a repository in `src/db/repositories/` (reader and writer split per CQRS).
- **New service / use-case:** add a module under `src/lib/services/` (or the relevant `lib/` subdir). Keep business computation here, not in `cloud-api` routes. Import `logger` from `../utils/logger`. Export from `lib/index.ts` only if a consumer needs the top barrel; otherwise rely on the `./lib/*` subpath.
- **New DTO type:** add to `src/types/cloud-api.ts` (or a sibling) and export via `types/index.ts`.

## Conventions / gotchas

- **`src/lib/` is server-only.** Browser code (React, hooks, stores, tailwind utils) lives in `cloud-frontend`, not here. Only pure isomorphic helpers (`billing/`, math/string/validation) are safe to import from the frontend.
- **Migrations are append-only.** Never edit an applied migration. No `CREATE INDEX CONCURRENTLY` (runs in a transaction). Use `IF NOT EXISTS` / `IF EXISTS`. Keep migrations small and targeted (<100 lines): add objects, backfill, and drop in separate migrations — no omnibus recreate-the-schema files (they lock active prod tables). Never `db:push`.
- **`typecheck` noise:** errors that surface are often from transitive imports (e.g. `plugins/plugin-elizacloud/...`) pulled in via tsconfig paths, not this package's own source. Filter to your files: `bun run --cwd packages/cloud-shared typecheck 2>&1 | grep <your-file>`.
- **Repo-wide rules** (logger-only/no-console, ESM, naming, clean-architecture commandments, CQRS, validate-at-boundary, DTO fields required) live in the root `AGENTS.md`. The WHY docs under `docs/` explain non-obvious choices: `messaging-onboarding-gateway-design.md` and `CLOUD_ONBOARDING_PROVISIONING_REVIEW.md`.
