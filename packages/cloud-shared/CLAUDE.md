# Eliza Cloud V2

## Stack
- **Runtime**: Bun
- **Framework**: Next.js 15 (App Router)
- **Database**: PostgreSQL + Drizzle ORM
- **Deployment**: Cloudflare Workers (API) + Cloudflare Pages (frontend)
- **UI**: React + Tailwind CSS

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
1. Edit schema in `db/schemas/`
2. `bun run db:generate`
3. Review SQL in `db/migrations/`
4. `bun run db:migrate`
5. Commit both schema + migration

### Custom Migrations
```bash
npx drizzle-kit generate --custom --name=descriptive_name
```

### Rules
- No `CREATE INDEX CONCURRENTLY` (runs in transaction)
- Use `IF NOT EXISTS` / `IF EXISTS` for creating tables
- Never edit applied migrations
- NEVER use omnibus migrations that recreate the full schema or existing objects - they will fail in production by locking active tables. Instead:
  1. Create small targeted migrations that ONLY add your new schema objects
  2. Use separate migrations for data backfills
  3. Put cleanup/drops in their own migration
  4. Group related objects together but limit migrations to <100 lines
- See `docs/database-migrations.md` for details

## Type Checking

**`bun run typecheck` has many pre-existing errors across the codebase (db/, lib/services/, app/).** Don't try to fix them all — only verify your changed files have no new errors. Filter output:
```bash
bun run typecheck 2>&1 | grep -E "(your-file\\.ts|your-other-file\\.ts)"
```
If the grep returns empty, your changes are clean. `bun run build` also fails on unrelated env vars (`ELIZA_APP_DISCORD_BOT_TOKEN`). Use `typecheck` filtered to your files instead.

## Project Structure
```
app/           # Next.js App Router pages
lib/           # Business logic, services
db/
  schemas/     # Drizzle schema definitions
  migrations/  # SQL migration files
  repositories/# Data access layer
components/    # React components
scripts/       # CLI utilities
```
