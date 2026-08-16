/**
 * Non-destructive data migration for the reminder tables carved out of
 * @elizaos/plugin-personal-assistant.
 *
 * The three reminder tables (`life_reminder_plans`, `life_reminder_attempts`,
 * `life_escalation_states`) used to live in the `app_lifeops` PostgreSQL schema,
 * created by plugin-personal-assistant. They now live in `app_reminders`,
 * created by this plugin's drizzle schema. Existing installs still hold the
 * owner's reminder rows in `app_lifeops`, so on first boot we copy them across —
 * once, idempotently, and WITHOUT ever touching the source.
 *
 * Guards (per table, independently):
 *   1. Skip if a durable completion marker for the table exists (the copy ran
 *      once on this database — live 2026-08-16 phantom-rows incident: without
 *      the marker, "skip if target non-empty" re-imported every stale
 *      app_lifeops row on the first restart after an owner cleared their
 *      routines, resurrecting long-deleted reminders).
 *   2. Skip if the source table does not exist (fresh install / already dropped).
 *   3. Skip if the target table is non-empty (plugin already owns live data).
 *   4. Otherwise copy every source row that is not already present in the target
 *      (a doubly-safe NOT EXISTS guard on the primary key).
 *
 * Every terminal outcome writes the marker, so the copy happens at most once
 * per database. The source table is NEVER dropped or altered.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";

export const REMINDERS_LOG_PREFIX = "[Reminders]";
export const REMINDERS_MIGRATION_SERVICE_TYPE = "reminders_migration";

const SOURCE_SCHEMA = "app_lifeops";
const TARGET_SCHEMA = "app_reminders";

export const MIGRATED_REMINDER_TABLES = [
  "life_reminder_plans",
  "life_reminder_attempts",
  "life_escalation_states",
] as const;

export type MigratedReminderTable = (typeof MIGRATED_REMINDER_TABLES)[number];

export type SqlExecutor = (
  sql: string,
) => Promise<Array<Record<string, unknown>>>;

export interface TableMigrationResult {
  table: MigratedReminderTable;
  outcome:
    | "copied"
    | "source-missing"
    | "target-non-empty"
    | "already-migrated";
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function sourceTableExists(
  exec: SqlExecutor,
  table: MigratedReminderTable,
): Promise<boolean> {
  const rows = await exec(
    `SELECT to_regclass('${SOURCE_SCHEMA}.${table}') IS NOT NULL AS present`,
  );
  return rows[0]?.present === true || rows[0]?.present === "true";
}

async function targetTableIsEmpty(
  exec: SqlExecutor,
  table: MigratedReminderTable,
): Promise<boolean> {
  const rows = await exec(
    `SELECT NOT EXISTS (SELECT 1 FROM ${TARGET_SCHEMA}.${quoteIdent(table)}) AS empty`,
  );
  return rows[0]?.empty === true || rows[0]?.empty === "true";
}

const MIGRATION_MARKER_TABLE = "reminders_migration_state";

async function ensureMigrationMarkerTable(exec: SqlExecutor): Promise<void> {
  await exec(
    `CREATE TABLE IF NOT EXISTS ${TARGET_SCHEMA}.${quoteIdent(MIGRATION_MARKER_TABLE)} (
       table_name TEXT PRIMARY KEY,
       migrated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
}

async function migrationMarkerExists(
  exec: SqlExecutor,
  table: MigratedReminderTable,
): Promise<boolean> {
  const rows = await exec(
    `SELECT EXISTS (
       SELECT 1 FROM ${TARGET_SCHEMA}.${quoteIdent(MIGRATION_MARKER_TABLE)}
       WHERE table_name = '${table}'
     ) AS done`,
  );
  return rows[0]?.done === true || rows[0]?.done === "true";
}

async function writeMigrationMarker(
  exec: SqlExecutor,
  table: MigratedReminderTable,
): Promise<void> {
  await exec(
    `INSERT INTO ${TARGET_SCHEMA}.${quoteIdent(MIGRATION_MARKER_TABLE)} (table_name)
     VALUES ('${table}')
     ON CONFLICT (table_name) DO NOTHING`,
  );
}

export async function migrateReminderTable(
  exec: SqlExecutor,
  table: MigratedReminderTable,
): Promise<TableMigrationResult> {
  if (await migrationMarkerExists(exec, table)) {
    return { table, outcome: "already-migrated" };
  }
  if (!(await sourceTableExists(exec, table))) {
    await writeMigrationMarker(exec, table);
    return { table, outcome: "source-missing" };
  }
  if (!(await targetTableIsEmpty(exec, table))) {
    await writeMigrationMarker(exec, table);
    return { table, outcome: "target-non-empty" };
  }

  const target = `${TARGET_SCHEMA}.${quoteIdent(table)}`;
  const source = `${SOURCE_SCHEMA}.${quoteIdent(table)}`;
  await exec(
    `INSERT INTO ${target}
       SELECT s.* FROM ${source} AS s
       WHERE NOT EXISTS (
         SELECT 1 FROM ${target} AS t WHERE t.id = s.id
       )
       ON CONFLICT (${quoteIdent("id")}) DO NOTHING`,
  );
  await writeMigrationMarker(exec, table);
  return { table, outcome: "copied" };
}

export async function migrateReminderTables(
  exec: SqlExecutor,
): Promise<TableMigrationResult[]> {
  await exec(`CREATE SCHEMA IF NOT EXISTS ${TARGET_SCHEMA}`);
  await ensureMigrationMarkerTable(exec);
  const results: TableMigrationResult[] = [];
  for (const table of MIGRATED_REMINDER_TABLES) {
    results.push(await migrateReminderTable(exec, table));
  }
  return results;
}

type RuntimeDb = {
  execute: (query: unknown) => Promise<unknown>;
};

function getRuntimeDb(runtime: IAgentRuntime): RuntimeDb {
  const db = runtime.db as RuntimeDb | undefined;
  if (!db || typeof db.execute !== "function") {
    throw new Error(
      `${REMINDERS_LOG_PREFIX} runtime.db is unavailable — @elizaos/plugin-sql must be loaded before @elizaos/plugin-reminders.`,
    );
  }
  return db;
}

function extractRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) {
    return result.filter(
      (row): row is Record<string, unknown> =>
        typeof row === "object" && row !== null && !Array.isArray(row),
    );
  }
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) {
      return rows.filter(
        (row): row is Record<string, unknown> =>
          typeof row === "object" && row !== null && !Array.isArray(row),
      );
    }
  }
  return [];
}

/**
 * Service whose `start()` performs the one-time, guarded, non-destructive copy
 * of the owner's reminder rows from `app_lifeops` into `app_reminders`.
 */
export class RemindersMigrationService extends Service {
  static override readonly serviceType = REMINDERS_MIGRATION_SERVICE_TYPE;

  override capabilityDescription =
    "Non-destructive one-time copy of reminder rows from app_lifeops into app_reminders during the plugin-reminders carve-out.";

  static async start(
    runtime: IAgentRuntime,
  ): Promise<RemindersMigrationService> {
    const service = new RemindersMigrationService(runtime);
    await service.run();
    return service;
  }

  private async run(): Promise<void> {
    const db = getRuntimeDb(this.runtime);
    const { sql } = await import("drizzle-orm");
    const exec: SqlExecutor = async (statement) =>
      extractRows(await db.execute(sql.raw(statement)));

    const results = await migrateReminderTables(exec);
    const copied = results.filter((r) => r.outcome === "copied");
    if (copied.length > 0) {
      logger.info(
        { tables: copied.map((r) => r.table) },
        `${REMINDERS_LOG_PREFIX} copied ${copied.length} reminder table(s) from ${SOURCE_SCHEMA} to ${TARGET_SCHEMA}`,
      );
    } else {
      logger.debug(
        { results },
        `${REMINDERS_LOG_PREFIX} no reminder tables required copying (already migrated or fresh install)`,
      );
    }
  }

  override async stop(): Promise<void> {}
}
