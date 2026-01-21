import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { Pool } from "pg";
import { readEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import * as schema from "./schema";

export type DatabaseClient =
  | ReturnType<typeof drizzlePglite<typeof schema>>
  | ReturnType<typeof drizzlePostgres<typeof schema>>;

let db: DatabaseClient | null = null;
let pglite: PGlite | null = null;
let pool: Pool | null = null;
let migrated = false;

const MIGRATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS soulmates_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone VARCHAR(20) NOT NULL UNIQUE,
    email VARCHAR(255),
    name VARCHAR(255),
    location VARCHAR(255),
    credits INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    is_admin BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS soulmates_users_phone_idx ON soulmates_users(phone);
  CREATE INDEX IF NOT EXISTS soulmates_users_status_idx ON soulmates_users(status);

  CREATE TABLE IF NOT EXISTS soulmates_allowlist (
    phone VARCHAR(20) PRIMARY KEY,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    added_by UUID REFERENCES soulmates_users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS soulmates_allowlist_added_at_idx ON soulmates_allowlist(added_at);

  CREATE TABLE IF NOT EXISTS soulmates_credit_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES soulmates_users(id) ON DELETE CASCADE,
    delta INTEGER NOT NULL,
    balance INTEGER NOT NULL,
    reason VARCHAR(50) NOT NULL,
    reference VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS soulmates_credit_ledger_user_idx ON soulmates_credit_ledger(user_id);
  CREATE INDEX IF NOT EXISTS soulmates_credit_ledger_reference_idx ON soulmates_credit_ledger(reference);

  CREATE TABLE IF NOT EXISTS soulmates_analytics_snapshots (
    day VARCHAR(10) PRIMARY KEY,
    snapshot JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS soulmates_analytics_snapshots_day_idx ON soulmates_analytics_snapshots(day);

  CREATE TABLE IF NOT EXISTS soulmates_rate_limits (
    key VARCHAR(255) PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 1,
    reset_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS soulmates_rate_limits_reset_idx ON soulmates_rate_limits(reset_at);

  CREATE TABLE IF NOT EXISTS soulmates_persona_map (
    persona_id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL UNIQUE REFERENCES soulmates_users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS soulmates_persona_map_user_idx ON soulmates_persona_map(user_id);

  CREATE TABLE IF NOT EXISTS soulmates_engine_state (
    id VARCHAR(32) PRIMARY KEY DEFAULT 'primary',
    state JSONB NOT NULL,
    cursor INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    last_run_at TIMESTAMPTZ,
    last_run_duration_ms INTEGER,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS soulmates_engine_state_updated_idx ON soulmates_engine_state(updated_at);
`;

async function runMigrations(): Promise<void> {
  if (migrated) return;

  try {
    if (pool) {
      await pool.query(MIGRATIONS_SQL);
    } else if (pglite) {
      await pglite.exec(MIGRATIONS_SQL);
    }
    if (pool) {
      await pool.query(
        "UPDATE soulmates_users SET status = 'active' WHERE status = 'pending'",
      );
    } else if (pglite) {
      await pglite.exec(
        "UPDATE soulmates_users SET status = 'active' WHERE status = 'pending'",
      );
    }
    migrated = true;
    logger.info("Database migrations completed");
  } catch (error) {
    logger.error("Database migration failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("Database migration failed");
  }
}

export async function getDatabase(): Promise<DatabaseClient> {
  if (db) return db;

  const postgresUrl = readEnv("POSTGRES_URL");

  if (postgresUrl) {
    pool = new Pool({ connectionString: postgresUrl });
    db = drizzlePostgres(pool, { schema });
    logger.info("Connected to PostgreSQL");
  } else {
    const dataDir = readEnv("PGLITE_DATA_DIR") ?? "./data/pglite";
    pglite = new PGlite(dataDir);
    db = drizzlePglite(pglite, { schema });
    logger.info("Connected to PGlite", { dataDir });
  }

  await runMigrations();
  return db;
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info("PostgreSQL connection closed");
  }
  if (pglite) {
    await pglite.close();
    pglite = null;
    logger.info("PGlite connection closed");
  }
  db = null;
  migrated = false;
}

export function resetMigrationState(): void {
  migrated = false;
}
