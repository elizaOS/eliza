# Database Migrations

This document outlines the proper workflow for managing database migrations with Drizzle ORM.

## Overview

We use [Drizzle ORM](https://orm.drizzle.team/) for database management. Migrations are stored in `db/migrations/` and tracked in `db/migrations/meta/_journal.json`.

**IMPORTANT**: As of this PR, `db:push` is deprecated. All schema changes MUST go through migrations.

## Why Migrations Matter

**The Problem**: Without proper migration tracking, you lose visibility into:
- What schema changes have been applied to production
- Whether local and production databases are in sync
- The order changes need to be applied in

**The Solution**: Drizzle tracks migrations via:
1. **SQL files** in `db/migrations/` - the actual DDL statements
2. **Journal** (`_journal.json`) - metadata about which migrations exist
3. **Database table** (`__drizzle_migrations`) - record of what's been applied

When these three sources are in sync, `db:migrate` reliably applies only pending changes.

## Key Principles

1. **Always use `db:generate`** to create migrations from schema changes
   - WHY: It generates proper journal entries and snapshots automatically
2. **Never manually create migration files** - they need proper snapshots and journal entries
   - WHY: Manual files won't be tracked and `db:migrate` will skip them
3. **Never use `db:push` in production** - it bypasses migration tracking
   - WHY: You won't know what's applied, making rollbacks impossible
4. **Review generated migrations** before committing
   - WHY: Auto-generated SQL may include unintended changes or destructive operations

## Workflow

### Making Schema Changes

1. **Modify the schema** in `db/schemas/`
2. **Generate migration**:
   ```bash
   bun run db:generate
   ```
3. **Review the generated migration** in `db/migrations/`
4. **Test locally**:
   ```bash
   bun run db:migrate
   ```
5. **Commit** both the schema change and migration

### Local Development

For local development setup:

```bash
# Full setup (starts Docker, runs migrations)
bun run db:local:setup

# Or manually:
bun run db:local:start    # Start PostgreSQL
bun run db:migrate        # Run migrations
```

### Available Commands

| Command | Description |
|---------|-------------|
| `bun run db:generate` | Generate migration from schema changes |
| `bun run db:migrate` | Run pending migrations |
| `bun run db:studio` | Open Drizzle Studio GUI |
| `bun run db:local:setup` | Complete local DB setup |
| `bun run db:local:start` | Start local PostgreSQL |
| `bun run db:local:stop` | Stop local PostgreSQL |

## Migration Files

Each migration consists of:

- **SQL file**: `db/migrations/XXXX_migration_name.sql`
- **Journal entry**: In `db/migrations/meta/_journal.json`

Drizzle also generates snapshot files (`XXXX_snapshot.json`) when using `db:generate`, but these are optional for migration tracking. The journal and SQL files are what matter for `db:migrate`.

## Troubleshooting

### Audit Migrations

To check the current state of migrations:

```bash
DATABASE_URL=... bun run scripts/audit-migrations.ts
```

This will show:
- Migration files on disk
- Journal entries
- Applied migrations in database (if connected)
- Any discrepancies

### Production Database Sync

After consolidation, for existing production databases:

1. Query what's applied:
   ```sql
   SELECT * FROM __drizzle_migrations ORDER BY id;
   ```

2. Insert entries for migrations applied via `db:push`:
   ```sql
   INSERT INTO "__drizzle_migrations" (hash, created_at)
   VALUES ('migration_tag_here', NOW());
   ```

## Custom Migrations

For changes that can't be auto-generated from TypeScript schemas (triggers, functions, complex constraints), use custom migrations:

```bash
npx drizzle-kit generate --custom --name=my_custom_migration
```

This creates an empty SQL file that you fill in manually.

**Important constraints for custom migrations:**
- Do NOT use `CREATE INDEX CONCURRENTLY` - drizzle runs migrations in transactions
- Use `IF NOT EXISTS` / `IF EXISTS` for idempotency
- Do NOT add duplicate statements that exist in other migrations

## Seeding Production Migration Tracking

When production was previously using `db:push`, you need to seed the `__drizzle_migrations` table:

1. **Dump production schema and compare** with what migrations create
2. **Compute hashes** for each migration file:
   ```bash
   sha256sum db/migrations/*.sql
   ```
3. **Insert records** for all applied migrations:
   ```sql
   INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
   VALUES
     ('hash_from_sha256sum', timestamp_from_journal),
     ...;
   ```

The `created_at` values must match the `when` timestamps in `_journal.json`.

## Best Practices

1. **Small, focused migrations**: One logical change per migration
   - WHY: Easier to debug failures, simpler rollbacks, clearer git history
2. **Idempotent when possible**: Use `IF NOT EXISTS` / `IF EXISTS` for safety
   - WHY: Allows re-running migrations safely if tracking gets out of sync
3. **Test migrations**: Always test on a fresh database before deploying
   - WHY: Catches issues before they affect production data
4. **No data migrations in schema migrations**: Separate data migrations from schema changes
   - WHY: Data migrations may need different rollback strategies and can be slow
5. **Never modify applied migrations**: Create new migrations instead
   - WHY: Modifying applied migrations causes checksum mismatches and breaks tracking
6. **Never use CONCURRENTLY in migrations**: Drizzle runs in transactions
   - Use `CREATE INDEX` without CONCURRENTLY keyword

## Directory Structure

```
db/
├── migrations/
│   ├── 0000_first_migration.sql
│   ├── 0001_second_migration.sql
│   └── meta/
│       └── _journal.json
├── schemas/
│   ├── index.ts
│   ├── users.ts
│   └── ...
└── repositories/
    └── ...
```
