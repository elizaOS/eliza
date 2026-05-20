#!/usr/bin/env bash

set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "❌ DATABASE_URL is required"
  exit 1
fi

# Drizzle config prefers DIRECT_DATABASE_URL in CI/non-local modes.
export DIRECT_DATABASE_URL="${DIRECT_DATABASE_URL:-$DATABASE_URL}"

echo "🧹 Resetting public schema..."
bun - <<'EOF'
import postgres from 'postgres';

const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('Missing DATABASE_URL');

const sql = postgres(url, { max: 1 });

const schemas = await sql<Array<{ schemaName: string }>>`
  select schema_name as "schemaName"
  from information_schema.schemata
  where schema_name not like 'pg_%'
    and schema_name <> 'information_schema'
`;

for (const { schemaName } of schemas) {
  const quoted = `"${schemaName.replaceAll('"', '""')}"`;
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoted} CASCADE;`);
}

await sql.unsafe('CREATE SCHEMA IF NOT EXISTS public;');

await sql.end({ timeout: 5 });
EOF

echo "🗄️  Syncing database schema (drizzle-kit push)..."
bun run --cwd packages/db db:push -- --force
echo "✅ Database schema synced"
