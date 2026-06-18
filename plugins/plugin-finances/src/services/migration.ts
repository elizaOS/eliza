/**
 * Non-destructive data migration for the finance tables carved out of
 * @elizaos/plugin-personal-assistant.
 *
 * The five finance tables (`life_payment_sources`, `life_payment_transactions`,
 * `life_subscription_audits`, `life_subscription_candidates`,
 * `life_subscription_cancellations`) used to live in the `app_lifeops`
 * PostgreSQL schema, created by plugin-personal-assistant. They now live in
 * `app_finances`, created by this plugin's drizzle schema. Existing installs
 * still hold the owner's finance rows in `app_lifeops`, so on first boot we
 * copy them across — once, idempotently, and WITHOUT ever touching the source.
 *
 * Guards (per table, independently):
 *   1. Skip if the source table does not exist (fresh install / already dropped).
 *   2. Skip if the target table is non-empty (migration already ran, or the
 *      plugin owns live data).
 *   3. Otherwise copy every source row that is not already present in the
 *      target (a doubly-safe NOT EXISTS guard on the primary key).
 *
 * The source table is NEVER dropped or altered. The target schema is created
 * defensively (`CREATE SCHEMA IF NOT EXISTS`) in case the migration runner
 * has not yet applied — the drizzle runner also issues this, so it is a no-op
 * in the normal path.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";

export const FINANCES_LOG_PREFIX = "[Finances]";
export const FINANCES_MIGRATION_SERVICE_TYPE = "finances_migration";

const SOURCE_SCHEMA = "app_lifeops";
const TARGET_SCHEMA = "app_finances";

/** Tables to copy, in the order their foreign-key-like references read best. */
export const MIGRATED_FINANCE_TABLES = [
  "life_payment_sources",
  "life_payment_transactions",
  "life_subscription_audits",
  "life_subscription_candidates",
  "life_subscription_cancellations",
] as const;

export type MigratedFinanceTable = (typeof MIGRATED_FINANCE_TABLES)[number];

/**
 * Minimal SQL executor contract. Returns the result rows of a query (empty for
 * statements). Real implementation goes through the runtime drizzle handle;
 * tests inject a fake.
 */
export type SqlExecutor = (
  sql: string,
) => Promise<Array<Record<string, unknown>>>;

export interface TableMigrationResult {
  table: MigratedFinanceTable;
  /** `"copied"` ran the INSERT; otherwise the reason it was skipped. */
  outcome: "copied" | "source-missing" | "target-non-empty";
}

function quoteIdent(name: string): string {
  // Identifiers here are compile-time literals (schema/table names), never user
  // input — but quote defensively so a stray name can never break out.
  return `"${name.replace(/"/g, '""')}"`;
}

async function sourceTableExists(
  exec: SqlExecutor,
  table: MigratedFinanceTable,
): Promise<boolean> {
  const rows = await exec(
    `SELECT to_regclass('${SOURCE_SCHEMA}.${table}') IS NOT NULL AS present`,
  );
  return rows[0]?.present === true || rows[0]?.present === "true";
}

async function targetTableIsEmpty(
  exec: SqlExecutor,
  table: MigratedFinanceTable,
): Promise<boolean> {
  const rows = await exec(
    `SELECT NOT EXISTS (SELECT 1 FROM ${TARGET_SCHEMA}.${quoteIdent(table)}) AS empty`,
  );
  return rows[0]?.empty === true || rows[0]?.empty === "true";
}

/**
 * Copy a single table from `app_lifeops` to `app_finances`, applying the three
 * guards. Pure aside from the injected executor — the unit tests drive this
 * directly.
 */
export async function migrateFinanceTable(
  exec: SqlExecutor,
  table: MigratedFinanceTable,
): Promise<TableMigrationResult> {
  if (!(await sourceTableExists(exec, table))) {
    return { table, outcome: "source-missing" };
  }
  if (!(await targetTableIsEmpty(exec, table))) {
    return { table, outcome: "target-non-empty" };
  }

  const target = `${TARGET_SCHEMA}.${quoteIdent(table)}`;
  const source = `${SOURCE_SCHEMA}.${quoteIdent(table)}`;
  // NOT EXISTS on the primary key is redundant given the empty-target guard,
  // but keeps the INSERT idempotent even under a concurrent re-run.
  await exec(
    `INSERT INTO ${target}
       SELECT s.* FROM ${source} AS s
       WHERE NOT EXISTS (
         SELECT 1 FROM ${target} AS t WHERE t.id = s.id
       )`,
  );
  return { table, outcome: "copied" };
}

/**
 * Run the guarded copy for every finance table. `CREATE SCHEMA IF NOT EXISTS`
 * first so the target is guaranteed to exist even if the migration runner has
 * not yet applied. Returns the per-table outcome for observability/testing.
 */
export async function migrateFinanceTables(
  exec: SqlExecutor,
): Promise<TableMigrationResult[]> {
  await exec(`CREATE SCHEMA IF NOT EXISTS ${TARGET_SCHEMA}`);
  const results: TableMigrationResult[] = [];
  for (const table of MIGRATED_FINANCE_TABLES) {
    results.push(await migrateFinanceTable(exec, table));
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
      `${FINANCES_LOG_PREFIX} runtime.db is unavailable — @elizaos/plugin-sql must be loaded before @elizaos/plugin-finances.`,
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
 * of the owner's finance rows from `app_lifeops` into `app_finances`.
 */
export class FinancesMigrationService extends Service {
  static override readonly serviceType = FINANCES_MIGRATION_SERVICE_TYPE;

  override capabilityDescription =
    "Non-destructive one-time copy of finance rows from app_lifeops into app_finances during the plugin-finances carve-out.";

  static async start(
    runtime: IAgentRuntime,
  ): Promise<FinancesMigrationService> {
    const service = new FinancesMigrationService(runtime);
    await service.run();
    return service;
  }

  private async run(): Promise<void> {
    const db = getRuntimeDb(this.runtime);
    const { sql } = await import("drizzle-orm");
    const exec: SqlExecutor = async (statement) =>
      extractRows(await db.execute(sql.raw(statement)));

    const results = await migrateFinanceTables(exec);
    const copied = results.filter((r) => r.outcome === "copied");
    if (copied.length > 0) {
      logger.info(
        { tables: copied.map((r) => r.table) },
        `${FINANCES_LOG_PREFIX} copied ${copied.length} finance table(s) from ${SOURCE_SCHEMA} to ${TARGET_SCHEMA}`,
      );
    } else {
      logger.debug(
        { results },
        `${FINANCES_LOG_PREFIX} no finance tables required copying (already migrated or fresh install)`,
      );
    }
  }

  override async stop(): Promise<void> {}
}
