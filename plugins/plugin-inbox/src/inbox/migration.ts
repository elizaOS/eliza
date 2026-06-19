/**
 * Non-destructive data migration for the inbox-triage tables carved out of
 * @elizaos/plugin-personal-assistant.
 *
 * The three tables (`life_inbox_triage_entries`, `life_inbox_triage_examples`,
 * `life_email_unsubscribes`) used to live in the `app_lifeops` PostgreSQL
 * schema, created by plugin-personal-assistant. They now live in `app_inbox`,
 * created by this plugin's drizzle schema. Existing installs still hold the
 * owner's triage rows in `app_lifeops`, so on first boot we copy them across —
 * once, idempotently, and WITHOUT ever touching the source.
 *
 * Guards (per table, independently):
 *   1. Skip if the source table does not exist (fresh install / already dropped).
 *   2. Skip if the target table is non-empty (migration already ran, or the
 *      plugin owns live data).
 *   3. Otherwise copy every source row that is not already present in the target
 *      (a doubly-safe NOT EXISTS guard on the primary key).
 *
 * The source table is NEVER dropped or altered. The source and target share the
 * exact column shape (PA's `app_lifeops` drizzle def and this plugin's
 * `app_inbox` def are column-identical), so the `SELECT s.*` copy is safe.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";

export const INBOX_MIGRATION_LOG_PREFIX = "[Inbox]";
export const INBOX_MIGRATION_SERVICE_TYPE = "inbox_migration";

const SOURCE_SCHEMA = "app_lifeops";
const TARGET_SCHEMA = "app_inbox";

export const MIGRATED_INBOX_TABLES = [
  "life_inbox_triage_entries",
  "life_inbox_triage_examples",
  "life_email_unsubscribes",
] as const;

export type MigratedInboxTable = (typeof MIGRATED_INBOX_TABLES)[number];

export type SqlExecutor = (
  sql: string,
) => Promise<Array<Record<string, unknown>>>;

export interface TableMigrationResult {
  table: MigratedInboxTable;
  outcome: "copied" | "source-missing" | "target-non-empty";
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function sourceTableExists(
  exec: SqlExecutor,
  table: MigratedInboxTable,
): Promise<boolean> {
  const rows = await exec(
    `SELECT to_regclass('${SOURCE_SCHEMA}.${table}') IS NOT NULL AS present`,
  );
  return rows[0]?.present === true || rows[0]?.present === "true";
}

async function targetTableIsEmpty(
  exec: SqlExecutor,
  table: MigratedInboxTable,
): Promise<boolean> {
  const rows = await exec(
    `SELECT NOT EXISTS (SELECT 1 FROM ${TARGET_SCHEMA}.${quoteIdent(table)}) AS empty`,
  );
  return rows[0]?.empty === true || rows[0]?.empty === "true";
}

export async function migrateInboxTable(
  exec: SqlExecutor,
  table: MigratedInboxTable,
): Promise<TableMigrationResult> {
  if (!(await sourceTableExists(exec, table))) {
    return { table, outcome: "source-missing" };
  }
  if (!(await targetTableIsEmpty(exec, table))) {
    return { table, outcome: "target-non-empty" };
  }

  const target = `${TARGET_SCHEMA}.${quoteIdent(table)}`;
  const source = `${SOURCE_SCHEMA}.${quoteIdent(table)}`;
  await exec(
    `INSERT INTO ${target}
       SELECT s.* FROM ${source} AS s
       WHERE NOT EXISTS (
         SELECT 1 FROM ${target} AS t WHERE t.id = s.id
       )`,
  );
  return { table, outcome: "copied" };
}

export async function migrateInboxTables(
  exec: SqlExecutor,
): Promise<TableMigrationResult[]> {
  await exec(`CREATE SCHEMA IF NOT EXISTS ${TARGET_SCHEMA}`);
  const results: TableMigrationResult[] = [];
  for (const table of MIGRATED_INBOX_TABLES) {
    results.push(await migrateInboxTable(exec, table));
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
      `${INBOX_MIGRATION_LOG_PREFIX} runtime.db is unavailable — @elizaos/plugin-sql must be loaded before @elizaos/plugin-inbox.`,
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
 * of the owner's inbox-triage rows from `app_lifeops` into `app_inbox`.
 */
export class InboxMigrationService extends Service {
  static override readonly serviceType = INBOX_MIGRATION_SERVICE_TYPE;

  override capabilityDescription =
    "Non-destructive one-time copy of inbox-triage rows from app_lifeops into app_inbox during the plugin-inbox carve-out.";

  static async start(runtime: IAgentRuntime): Promise<InboxMigrationService> {
    const service = new InboxMigrationService(runtime);
    await service.run();
    return service;
  }

  private async run(): Promise<void> {
    const db = getRuntimeDb(this.runtime);
    const { sql } = await import("drizzle-orm");
    const exec: SqlExecutor = async (statement) =>
      extractRows(await db.execute(sql.raw(statement)));

    const results = await migrateInboxTables(exec);
    const copied = results.filter((r) => r.outcome === "copied");
    if (copied.length > 0) {
      logger.info(
        { tables: copied.map((r) => r.table) },
        `${INBOX_MIGRATION_LOG_PREFIX} copied ${copied.length} inbox table(s) from ${SOURCE_SCHEMA} to ${TARGET_SCHEMA}`,
      );
    } else {
      logger.debug(
        { results },
        `${INBOX_MIGRATION_LOG_PREFIX} no inbox tables required copying (already migrated or fresh install)`,
      );
    }
  }

  override async stop(): Promise<void> {}
}
