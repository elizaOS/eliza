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
 * Each source table is reconciled by primary key even when the target already
 * contains live data. Missing rows are copied, same-key value drift fails
 * closed, and complete readback is required before receipt completion.
 * Verification uses `/v2` receipts so unsafe completed `/v1` receipts trigger
 * one repair pass without making later owner deletions replay from the source.
 *
 * The older package-local marker remains compatibility evidence but is not
 * trusted to skip verification. The source table is NEVER dropped or altered.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import {
  assertCarveOutProjectionComplete,
  type CarveOutDatabase,
  createDrizzleCarveOutDatabase,
  runCarveOutMigration,
} from "@elizaos/plugin-sql";

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
  outcome: "copied" | "source-missing" | "already-migrated";
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

const MIGRATION_MARKER_TABLE = "reminders_migration_state";

async function ensureMigrationMarkerTable(exec: SqlExecutor): Promise<void> {
  await exec(
    `CREATE TABLE IF NOT EXISTS ${TARGET_SCHEMA}.${quoteIdent(MIGRATION_MARKER_TABLE)} (
       table_name TEXT PRIMARY KEY,
       migrated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
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
  if (!(await sourceTableExists(exec, table))) {
    return { table, outcome: "source-missing" };
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
  await assertCarveOutProjectionComplete(exec, {
    migrationKey: `reminders/${table}/v2`,
    source: { schema: SOURCE_SCHEMA, table },
    target: { schema: TARGET_SCHEMA, table },
    keyColumns: ["id"],
  });
  await writeMigrationMarker(exec, table);
  return { table, outcome: "copied" };
}

export async function migrateReminderTables(
  database: CarveOutDatabase,
): Promise<TableMigrationResult[]> {
  await database.execute(`CREATE SCHEMA IF NOT EXISTS ${TARGET_SCHEMA}`);
  await ensureMigrationMarkerTable(database.execute);
  const results: TableMigrationResult[] = [];
  for (const table of MIGRATED_REMINDER_TABLES) {
    const receipt = await runCarveOutMigration(database, {
      key: `reminders/${table}/v2`,
      sourceTables: [{ schema: SOURCE_SCHEMA, table }],
      run: (execute) => migrateReminderTable(execute, table),
      outcome: (result) => result.outcome,
      shouldComplete: (result) => result.outcome !== "source-missing",
    });
    results.push(
      receipt.status === "completed"
        ? receipt.value
        : { table, outcome: "already-migrated" },
    );
  }
  return results;
}

type RuntimeDb = {
  execute: (query: unknown) => Promise<unknown>;
  transaction<T>(operation: (transaction: RuntimeDb) => Promise<T>): Promise<T>;
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
    const database = await createDrizzleCarveOutDatabase(db);
    const results = await migrateReminderTables(database);
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
