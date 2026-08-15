/**
 * Non-destructive data migration for ScheduledTask rows carved out of
 * @elizaos/plugin-personal-assistant.
 *
 * Scheduled tasks and their state log used to live in `app_lifeops`. They now
 * live in scheduling-owned `app_scheduling`; this service creates/repairs the
 * target schema and copies existing source rows once without deleting or
 * mutating the old tables.
 */
import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import { executeRawSql, getRuntimeDb } from "./sql.js";

export const SCHEDULING_MIGRATION_SERVICE_TYPE = "scheduling_migration";
export const SCHEDULING_MIGRATION_LOG_PREFIX = "[Scheduling]";

const SOURCE_SCHEMA = "app_lifeops";
const TARGET_SCHEMA = "app_scheduling";

export const MIGRATED_SCHEDULING_TABLES = [
  "life_scheduled_tasks",
  "life_scheduled_task_log",
] as const;

export type MigratedSchedulingTable =
  (typeof MIGRATED_SCHEDULING_TABLES)[number];

export type SqlExecutor = (
  sql: string,
) => Promise<Array<Record<string, unknown>>>;

export interface TableMigrationResult {
  table: MigratedSchedulingTable;
  outcome: "copied" | "source-missing";
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function isTruthy(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function scalar(
  row: Record<string, unknown> | undefined,
  key: string,
): unknown {
  if (!row) return undefined;
  return key in row ? row[key] : Object.values(row)[0];
}

async function sourceTableExists(
  exec: SqlExecutor,
  table: MigratedSchedulingTable,
): Promise<boolean> {
  const rows = await exec(
    `SELECT to_regclass('${SOURCE_SCHEMA}.${table}') IS NOT NULL AS present`,
  );
  return isTruthy(scalar(rows[0], "present"));
}

export async function ensureSchedulingTables(exec: SqlExecutor): Promise<void> {
  await exec(`CREATE SCHEMA IF NOT EXISTS ${TARGET_SCHEMA}`);
  await exec(
    `CREATE TABLE IF NOT EXISTS ${TARGET_SCHEMA}.life_scheduled_tasks (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      prompt_instructions TEXT NOT NULL,
      context_request_json TEXT,
      trigger_json TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'medium',
      should_fire_json TEXT,
      completion_check_json TEXT,
      escalation_json TEXT,
      output_json TEXT,
      pipeline_json TEXT,
      subject_kind TEXT,
      subject_id TEXT,
      idempotency_key TEXT,
      respects_global_pause BOOLEAN NOT NULL DEFAULT TRUE,
      state_json TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL DEFAULT 'user_chat',
      created_by TEXT NOT NULL DEFAULT '',
      owner_visible BOOLEAN NOT NULL DEFAULT TRUE,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      execution_profile TEXT,
      transfer_token TEXT,
      transfer_target_agent_id TEXT,
      transfer_status TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      next_fire_at TIMESTAMPTZ,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );
  await exec(
    `ALTER TABLE ${TARGET_SCHEMA}.life_scheduled_tasks
       ADD COLUMN IF NOT EXISTS execution_profile TEXT`,
  );
  await exec(
    `ALTER TABLE ${TARGET_SCHEMA}.life_scheduled_tasks
       ADD COLUMN IF NOT EXISTS transfer_token TEXT,
       ADD COLUMN IF NOT EXISTS transfer_target_agent_id TEXT,
       ADD COLUMN IF NOT EXISTS transfer_status TEXT`,
  );
  await exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduling_tasks_agent_idempotency
      ON ${TARGET_SCHEMA}.life_scheduled_tasks (agent_id, idempotency_key)`,
  );
  await exec(
    `CREATE INDEX IF NOT EXISTS idx_scheduling_tasks_agent_kind
      ON ${TARGET_SCHEMA}.life_scheduled_tasks (agent_id, kind)`,
  );
  await exec(
    `CREATE INDEX IF NOT EXISTS idx_scheduling_tasks_subject
      ON ${TARGET_SCHEMA}.life_scheduled_tasks (agent_id, subject_kind, subject_id)`,
  );
  await exec(
    `CREATE INDEX IF NOT EXISTS idx_scheduling_tasks_due
      ON ${TARGET_SCHEMA}.life_scheduled_tasks (agent_id, next_fire_at)
      WHERE (state_json::jsonb ->> 'status') IN ('scheduled', 'fired', 'acknowledged', 'completed', 'skipped', 'expired', 'failed')`,
  );
  await exec(
    `CREATE TABLE IF NOT EXISTS ${TARGET_SCHEMA}.life_scheduled_task_log (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      transition TEXT NOT NULL,
      reason TEXT,
      rolled_up BOOLEAN NOT NULL DEFAULT FALSE,
      detail_json TEXT
    )`,
  );
  await exec(
    `CREATE INDEX IF NOT EXISTS idx_scheduling_task_log_agent_task
      ON ${TARGET_SCHEMA}.life_scheduled_task_log (agent_id, task_id)`,
  );
  await exec(
    `CREATE INDEX IF NOT EXISTS idx_scheduling_task_log_agent_time
      ON ${TARGET_SCHEMA}.life_scheduled_task_log (agent_id, occurred_at)`,
  );
}

export async function migrateSchedulingTable(
  exec: SqlExecutor,
  table: MigratedSchedulingTable,
): Promise<TableMigrationResult> {
  if (!(await sourceTableExists(exec, table))) {
    return { table, outcome: "source-missing" };
  }
  const target = `${TARGET_SCHEMA}.${quoteIdent(table)}`;
  const source = `${SOURCE_SCHEMA}.${quoteIdent(table)}`;
  if (table === "life_scheduled_tasks") {
    const legacyColumns = [
      "id",
      "agent_id",
      "kind",
      "prompt_instructions",
      "context_request_json",
      "trigger_json",
      "priority",
      "should_fire_json",
      "completion_check_json",
      "escalation_json",
      "output_json",
      "pipeline_json",
      "subject_kind",
      "subject_id",
      "idempotency_key",
      "respects_global_pause",
      "state_json",
      "source",
      "created_by",
      "owner_visible",
      "metadata_json",
      "version",
      "next_fire_at",
      "created_at",
      "updated_at",
    ].join(", ");
    await exec(
      `INSERT INTO ${target} (${legacyColumns})
       SELECT ${legacyColumns} FROM ${source}
       ON CONFLICT DO NOTHING`,
    );
  } else {
    await exec(
      `INSERT INTO ${target}
       SELECT s.* FROM ${source} AS s
       ON CONFLICT DO NOTHING`,
    );
  }
  return { table, outcome: "copied" };
}

export async function migrateSchedulingTables(
  exec: SqlExecutor,
): Promise<TableMigrationResult[]> {
  await ensureSchedulingTables(exec);
  const results: TableMigrationResult[] = [];
  for (const table of MIGRATED_SCHEDULING_TABLES) {
    results.push(await migrateSchedulingTable(exec, table));
  }
  return results;
}

export class SchedulingMigrationService extends Service {
  static override readonly serviceType = SCHEDULING_MIGRATION_SERVICE_TYPE;

  override capabilityDescription =
    "Creates app_scheduling ScheduledTask tables and non-destructively copies legacy app_lifeops rows into them.";

  override async stop(): Promise<void> {}

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<SchedulingMigrationService> {
    const service = new SchedulingMigrationService(runtime);
    if (getRuntimeDb(runtime)) await service.run();
    return service;
  }

  private async run(): Promise<void> {
    const results = await migrateSchedulingTables((sql) =>
      executeRawSql(this.runtime, sql),
    );
    logger.info(
      { src: "scheduling:migration", results },
      `${SCHEDULING_MIGRATION_LOG_PREFIX} Scheduling table migration checked.`,
    );
  }
}
