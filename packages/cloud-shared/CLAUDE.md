# @elizaos/cloud-shared

Single backend package consumed by `@elizaos/cloud-api` (Cloudflare Worker), `@elizaos/cloud-frontend` (Vite/React + Cloudflare Pages), `@elizaos/cloud-services/*`, and a few plugins.

Was previously a workspace root with sub-packages `billing/`, `db/`, `lib/`, `types/`. Now collapsed into one package with subpath exports.

## Stack

- **Runtime**: Bun (server) / browser (only the bits cloud-frontend imports)
- **Database**: PostgreSQL via Drizzle ORM (Neon in prod, PGlite locally)
- **API consumer**: `cloud-api` (Hono on Cloudflare Workers)
- **UI consumer**: `cloud-frontend` (Vite + React 19, NOT Next.js)

## Layout

```
src/
  billing/    @elizaos/cloud-shared/billing  — markup arithmetic (pure, isomorphic)
  db/         @elizaos/cloud-shared/db       — drizzle schemas, repositories, migrations
  lib/        @elizaos/cloud-shared/lib      — server services (Discord/Telegram/Twitter/Hetzner/sandbox/etc.)
  types/      @elizaos/cloud-shared/types    — Cloudflare worker env + API DTO types
  index.ts                                   — top-level barrel (re-exports as namespaces)
drizzle.config.ts                            — points at ./src/db/{schemas,migrations}
```

Subpath imports: `import { ... } from "@elizaos/cloud-shared/db"`, `"@elizaos/cloud-shared/lib/services/x"`, etc.

## Commands

```bash
bun install                                  # from repo root
bun run --cwd packages/cloud-shared typecheck
bun run --cwd packages/cloud-shared db:generate   # drizzle-kit generate
bun run --cwd packages/cloud-shared db:migrate    # via scripts/cloud/admin/migrate-with-diagnostics.ts
bun run --cwd packages/cloud-shared db:studio
```

From repo root:
```bash
bun run dev:cloud                            # cloud-api + cloud-frontend concurrently
bun run typecheck:cloud                      # all four cloud-* packages
bun run db:cloud:generate / db:cloud:migrate / db:cloud:studio
```

## Database Migrations

**Never use `db:push` — all schema changes go through migrations.**

### Schema Change Workflow
1. Edit schema in `src/db/schemas/`
2. `bun run db:generate`
3. Review SQL in `src/db/migrations/`
4. `bun run db:migrate`
5. Commit both schema + migration

### Custom Migrations
```bash
bunx drizzle-kit generate --custom --name=descriptive_name
```

### Rules
- No `CREATE INDEX CONCURRENTLY` (runs in transaction)
- Use `IF NOT EXISTS` / `IF EXISTS` for creating tables
- Never edit applied migrations
- NEVER use omnibus migrations that recreate the full schema or existing objects — they lock active tables in production. Instead:
  1. Small targeted migrations that ONLY add new schema objects
  2. Separate migrations for data backfills
  3. Put cleanup/drops in their own migration
  4. Group related objects but cap migrations at <100 lines

## Type Checking

`bun run typecheck` is mostly clean on cloud-shared's own source. Errors that surface are typically in transitive imports (e.g., `plugins/plugin-elizacloud/...`) that cloud-shared pulls in via tsconfig paths. Filter to verify your own changes:

```bash
bun run typecheck 2>&1 | grep -E "(your-file\.ts|your-other-file\.ts)"
```

Empty grep = your changes are clean.

## Architecture rules (from repo `AGENTS.md`)

- **No business computation in cloud-api routes** — derive in this package's `lib/` (use-cases) and return DTO fields the client just renders (commandments #2, #3, #4)
- **CQRS in `db/repositories/`** — readers return domain objects, writers return void or ID (commandment #6)
- **Validate at the route boundary, trust in use cases** — no duplicate inline regex (#7)
- **DTO fields required by default** — no `?? 0` to mask missing fields (#8)
- **Logger only, never console** — `import { logger } from "./utils/logger"` inside `lib/`; structured `[ClassName]` prefix on messages (#9)

## Browser vs server

`src/lib/` is server-only. Anything browser-shaped (React components, hooks, providers, zustand stores, clsx/tailwind-merge utilities) was moved to `packages/cloud-frontend/src/` during the migration. If you need to add new browser code, put it in cloud-frontend, not here.

The exception: pure isomorphic helpers (string utilities, math, validation) can live in `lib/` or `billing/` and be consumed by both.
