# @elizaos/cloud-shared

Shared backend code for Eliza Cloud: billing arithmetic, Drizzle DB schemas/repositories/migrations, the server-side service library, transport types, and route/auth helpers. This is a private workspace library — there is no app or dev server here. Consumers import its source directly via subpath exports.

## Consumers

- `@elizaos/cloud-api` — Hono API on Cloudflare Workers; imports `lib/`, `db/`, `billing/`, `types/`.
- `@elizaos/cloud-frontend` — Vite + React 19 (Cloudflare Pages); imports only the isomorphic bits (`billing/`, some `types/`).
- `@elizaos/cloud-services/container-control-plane` — Node service for Hetzner container provisioning.
- A few plugins (e.g. `plugin-streaming` via `@elizaos/cloud-routing`).

## Source layout

```
src/
  index.ts        top barrel — re-exports billing/db/lib/types as namespaces
  billing/        pure, isomorphic markup math (applyMarkup, credit markup, Twilio SMS)
  db/             Drizzle layer — schemas/ (97), repositories/ (66, CQRS), migrations/,
                  client.ts, worker-neon-http.ts, database-url.ts, crypto/, utils/
  lib/            SERVER-ONLY services + use-cases — services/ (207), auth*.ts,
                  api/ middleware/ cors/ http/ session/, stripe.ts, pricing.ts,
                  promotion-pricing.ts, utils/logger.ts
  types/          cloud-api.ts (DTOs), cloud-worker-env.ts, stripe-queue-message.ts
drizzle.config.ts            schema ./src/db/schemas, out ./src/db/migrations
scripts/messaging-gateway-preflight.mjs
docs/                        WHY docs (provisioning, messaging gateways)
```

Import via subpath: `@elizaos/cloud-shared/billing`, `/db`, `/db/repositories/apps`, `/lib`, `/lib/services/<x>`, `/types`. Exports map (`package.json`): `.` `./billing` `./db` `./db/*` `./lib` `./lib/*` `./types` `./types/*`.

`src/lib/` is server-only — browser code lives in `cloud-frontend`. Only the isomorphic helpers (`billing/`, math/string/validation) are safe to import from the frontend.

## Commands

```bash
bun run --cwd packages/cloud-shared typecheck            # tsc --noEmit
bun run --cwd packages/cloud-shared lint                 # biome check
bun run --cwd packages/cloud-shared lint:fix
bun run --cwd packages/cloud-shared test                 # bun test
bun run --cwd packages/cloud-shared db:generate          # drizzle-kit generate
bun run --cwd packages/cloud-shared db:migrate           # migrate-with-diagnostics.ts
bun run --cwd packages/cloud-shared db:migrate:drizzle   # drizzle-kit migrate
bun run --cwd packages/cloud-shared db:studio            # drizzle-kit studio
bun run --cwd packages/cloud-shared db:check-migrations  # drizzle-kit check
bun run --cwd packages/cloud-shared preflight:messaging-gateways
```

There is no build step here (`build:linked-workspaces` defers to the repo-root `build:core`).

## Config

`db/database-url.ts` resolves the Postgres URL: explicit `DATABASE_URL` / `TEST_DATABASE_URL` (Neon in production) wins; otherwise local dev falls back to a file-backed PGlite store at `pglite://<cwd>/.eliza/.pgdata` (override the path with `PGLITE_DATA_DIR` / `LOCAL_DATABASE_PATH`). The `lib/` services read service-specific env (Stripe, Steward session/JWT secrets, BitRouter/provider keys, Telegram/Discord/WhatsApp, Hetzner/container infra). See `.env.example` for the full set.

## More

See [CLAUDE.md](./CLAUDE.md) for the migration workflow, how to add tables/services/DTOs, and the architecture rules (CQRS, server-only `lib/`, append-only migrations). WHY docs live under `docs/`.
