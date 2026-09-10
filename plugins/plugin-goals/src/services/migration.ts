/**
 * Non-destructive data migration for the goal tables carved out of
 * @elizaos/plugin-personal-assistant.
 *
 * The two goal tables (`life_goal_definitions`, `life_goal_links`) used to live
 * in the `app_lifeops` PostgreSQL schema, created by plugin-personal-assistant.
 * They now live in `app_goals`, created by this plugin's drizzle schema.
 * Existing installs still hold the owner's goal rows in `app_lifeops`, so on
 * first boot we copy them across — once, idempotently, and WITHOUT ever touching
 * the source.
 *
 * Each source table is reconciled by primary key even when the target already
 * contains live data. Missing rows are copied, same-key value drift fails
 * closed, and complete readback is required before receipt completion.
 * Verification uses `/v2` receipts so unsafe completed `/v1` receipts trigger
 * one repair pass without making later owner deletions replay from the source.
 *
 * The source table is NEVER dropped or altered. The source and target share the
 * exact column shape (PA's `app_lifeops` drizzle def and this plugin's
 * `app_goals` def are column-identical), so the `SELECT s.*` copy is safe.
 *
 * Definitions are copied before links so a reader observing mid-copy never sees
 * a link to a not-yet-copied definition.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import {
  assertCarveOutProjectionComplete,
  type CarveOutDatabase,
  createDrizzleCarveOutDatabase,
  runCarveOutMigration,
} from "@elizaos/plugin-sql";

export const GOALS_MIGRATION_LOG_PREFIX = "[Goals]";
export const GOALS_MIGRATION_SERVICE_TYPE = "goals_migration";

const SOURCE_SCHEMA = "app_lifeops";
const TARGET_SCHEMA = "app_goals";

export const MIGRATED_GOAL_TABLES = [
  "life_goal_definitions",
  "life_goal_links",
] as const;

export type MigratedGoalTable = (typeof MIGRATED_GOAL_TABLES)[number];

export type SqlExecutor = (
  sql: string,
) => Promise<Array<Record<string, unknown>>>;

export interface TableMigrationResult {
  table: MigratedGoalTable;
  outcome: "copied" | "source-missing" | "already-migrated";
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function sourceTableExists(
  exec: SqlExecutor,
  table: MigratedGoalTable,
): Promise<boolean> {
  const rows = await exec(
    `SELECT to_regclass('${SOURCE_SCHEMA}.${table}') IS NOT NULL AS present`,
  );
  return rows[0]?.present === true || rows[0]?.present === "true";
}

export async function migrateGoalTable(
  exec: SqlExecutor,
  table: MigratedGoalTable,
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
    migrationKey: `goals/${table}/v2`,
    source: { schema: SOURCE_SCHEMA, table },
    target: { schema: TARGET_SCHEMA, table },
    keyColumns: ["id"],
  });
  return { table, outcome: "copied" };
}

export async function migrateGoalTables(
  database: CarveOutDatabase,
): Promise<TableMigrationResult[]> {
  await database.execute(`CREATE SCHEMA IF NOT EXISTS ${TARGET_SCHEMA}`);
  const results: TableMigrationResult[] = [];
  for (const table of MIGRATED_GOAL_TABLES) {
    const receipt = await runCarveOutMigration(database, {
      key: `goals/${table}/v2`,
      sourceTables: [{ schema: SOURCE_SCHEMA, table }],
      run: (execute) => migrateGoalTable(execute, table),
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
      `${GOALS_MIGRATION_LOG_PREFIX} runtime.db is unavailable — @elizaos/plugin-sql must be loaded before @elizaos/plugin-goals.`,
    );
  }
  return db;
}

/**
 * Service whose `start()` performs the one-time, guarded, non-destructive copy
 * of the owner's goal rows from `app_lifeops` into `app_goals`.
 */
export class GoalsMigrationService extends Service {
  static override readonly serviceType = GOALS_MIGRATION_SERVICE_TYPE;

  override capabilityDescription =
    "Non-destructive one-time copy of goal rows from app_lifeops into app_goals during the plugin-goals carve-out.";

  static async start(runtime: IAgentRuntime): Promise<GoalsMigrationService> {
    const service = new GoalsMigrationService(runtime);
    await service.run();
    return service;
  }

  private async run(): Promise<void> {
    const db = getRuntimeDb(this.runtime);
    const database = await createDrizzleCarveOutDatabase(db);
    const results = await migrateGoalTables(database);
    const copied = results.filter((r) => r.outcome === "copied");
    if (copied.length > 0) {
      logger.info(
        { tables: copied.map((r) => r.table) },
        `${GOALS_MIGRATION_LOG_PREFIX} copied ${copied.length} goal table(s) from ${SOURCE_SCHEMA} to ${TARGET_SCHEMA}`,
      );
    } else {
      logger.debug(
        { results },
        `${GOALS_MIGRATION_LOG_PREFIX} no goal tables required copying (already migrated or fresh install)`,
      );
    }
  }

  override async stop(): Promise<void> {}
}
