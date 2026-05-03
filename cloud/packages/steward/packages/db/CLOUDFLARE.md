# Running migrations against Neon (Workers deployments)

The Workers entry (`packages/api/src/worker.ts`) intentionally does NOT run
`runMigrations()` at boot:

- Workers cold-boot is on the request path; blocking on a migration would push
  every request past the 30s subrequest budget.
- Workers cannot use the postgres-js TCP migrator at all — `drizzle-orm/postgres-js/migrator`
  reads files via `node:fs` (unsupported on Workers) and opens TCP sockets
  (also unsupported).

The `wrangler.toml` shipped with this repo sets `SKIP_MIGRATIONS = "1"` so the
Bun entry honors the same guard if ever deployed in a Workers-style envelope.

## Run migrations from CI / a one-shot script

`drizzle-kit migrate` is the canonical way. It connects via standard Postgres
TCP using `DATABASE_URL` and applies any pending files in
`packages/db/drizzle/` in lexicographic order, tracking applied versions in
`__drizzle_migrations`.

```bash
# 1. Get a TCP-capable Postgres URL for your Neon database.
#    (Neon's pooler URL works; the HTTP-only URL does not — drizzle-kit needs
#     a real connection.)
export DATABASE_URL="postgres://USER:PASS@ep-XYZ.us-east-2.aws.neon.tech/dbname?sslmode=require"

# 2. Apply all pending migrations.
cd packages/db
bun run migrate:neon
# equivalent: bunx drizzle-kit migrate
```

## Bootstrap the auth_kv_store table

`packages/auth/src/store-backends.ts` lazily creates the `auth_kv_store` table
on first use via `CREATE TABLE IF NOT EXISTS`. This works on Workers too (the
neon-http driver supports DDL), but for predictable cold-start latency you can
optionally pre-create it during the migration step. There is no separate
migration file for it today — the table definition is inline in
`PostgresBackend.ensureTable()`.

## CI integration

A typical GitHub Actions workflow:

```yaml
- name: Apply Steward DB migrations
  run: bun run migrate:neon
  env:
    DATABASE_URL: ${{ secrets.NEON_TCP_URL }}
```

Run this BEFORE `wrangler deploy` so the new schema is in place when the
Worker starts serving traffic. There is no rollback step — Drizzle
migrations are forward-only.

## Schema compatibility with neon-http

The neon-http driver uses Neon's serverless HTTP transport. It supports the
full Postgres SQL surface that Steward uses (DDL, prepared statements,
transactions). The constructs Steward does NOT use, and which would not work
over HTTP, are:

- `LISTEN` / `NOTIFY` — pubsub
- Advisory locks (`pg_advisory_lock`)
- `COPY` streaming
- Long-running transactions across multiple statements

Verified against `packages/db/src/schema.ts` and `schema-auth.ts`: none of
these are used.
