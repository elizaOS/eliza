/**
 * Durable orchestration for one-time plugin table carve-outs.
 *
 * Domain plugins retain their explicit copy/repair SQL. This module owns the
 * shared receipt claim so repeated or concurrent startup cannot replay a
 * completed legacy import after an owner deletes data from the new table.
 */

import { ElizaError } from "@elizaos/core";

export type CarveOutSqlExecutor = (statement: string) => Promise<Array<Record<string, unknown>>>;

/** A database boundary whose callback owns one connection for the full transaction. */
export interface CarveOutDatabase {
  execute: CarveOutSqlExecutor;
  transaction<T>(operation: (execute: CarveOutSqlExecutor) => Promise<T>): Promise<T>;
}

type DrizzleExecutor = {
  execute(query: unknown): Promise<unknown>;
};

type DrizzleTransactionalDatabase = DrizzleExecutor & {
  transaction?<T>(operation: (transaction: DrizzleExecutor) => Promise<T>): Promise<T>;
};

export type CarveOutRunResult<T> =
  | { status: "completed"; value: T }
  | { status: "already-completed" };

const RECEIPT_SCHEMA = "app_eliza_migrations";
const RECEIPT_TABLE = "carve_out_receipts";

const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function firstValue(row: Record<string, unknown> | undefined): unknown {
  return row ? Object.values(row)[0] : undefined;
}

function qualifiedTable(schema: string, table: string): string {
  if (!SQL_IDENTIFIER.test(schema) || !SQL_IDENTIFIER.test(table)) {
    throw new Error("Carve-out migration table identifier is invalid");
  }
  return `"${schema}"."${table}"`;
}

function countValue(row: Record<string, unknown> | undefined, key: string): number {
  const value = row?.[key];
  const count = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new ElizaError("Carve-out migration verification result is unreadable", {
      code: "CARVE_OUT_MIGRATION_VERIFICATION_INVALID",
      context: { key, value },
      severity: "fatal",
    });
  }
  return count;
}

function extractRows(result: unknown): Array<Record<string, unknown>> {
  const rows =
    result && typeof result === "object" && "rows" in result
      ? (result as { rows: unknown }).rows
      : result;
  return Array.isArray(rows)
    ? rows.filter(
        (row): row is Record<string, unknown> =>
          typeof row === "object" && row !== null && !Array.isArray(row)
      )
    : [];
}

/** Adapt a real Drizzle PostgreSQL/PGlite database without losing its transaction session. */
export async function createDrizzleCarveOutDatabase(
  database: DrizzleTransactionalDatabase
): Promise<CarveOutDatabase> {
  const transaction = database.transaction;
  if (typeof transaction !== "function") {
    throw new ElizaError("Carve-out migration requires an owned database transaction", {
      code: "CARVE_OUT_MIGRATION_TRANSACTION_REQUIRED",
      severity: "fatal",
    });
  }
  const transactionalDatabase = database as DrizzleExecutor & {
    transaction<T>(operation: (executor: DrizzleExecutor) => Promise<T>): Promise<T>;
  };
  const { sql } = await import("drizzle-orm");
  const executeWith =
    (executor: DrizzleExecutor): CarveOutSqlExecutor =>
    async (statement) =>
      extractRows(await executor.execute(sql.raw(statement)));
  return {
    execute: executeWith(database),
    transaction: (operation) =>
      transactionalDatabase.transaction((transactionExecutor) =>
        operation(executeWith(transactionExecutor))
      ),
  };
}

/**
 * Certify that every legacy row has an exact same-key projection in its new
 * owner table. Target-only additive columns are allowed; every source column
 * and value must still be present. This runs after an idempotent missing-row
 * copy and before the durable completion receipt is written.
 */
export async function assertCarveOutProjectionComplete(
  exec: CarveOutSqlExecutor,
  options: {
    migrationKey: string;
    source: { schema: string; table: string };
    target: { schema: string; table: string };
    keyColumns: readonly string[];
  }
): Promise<void> {
  if (
    options.keyColumns.length === 0 ||
    options.keyColumns.some((column) => !SQL_IDENTIFIER.test(column))
  ) {
    throw new Error("Carve-out migration key columns are invalid");
  }
  const source = qualifiedTable(options.source.schema, options.source.table);
  const target = qualifiedTable(options.target.schema, options.target.table);
  const keyJoin = options.keyColumns
    .map((column) => `t."${column}" IS NOT DISTINCT FROM s."${column}"`)
    .join(" AND ");
  const targetAbsent = options.keyColumns.map((column) => `t."${column}" IS NULL`).join(" AND ");
  const sourceKeyNull = options.keyColumns.map((column) => `s."${column}" IS NULL`).join(" OR ");
  const targetKeyNull = options.keyColumns.map((column) => `t."${column}" IS NULL`).join(" OR ");
  const groupedKeys = options.keyColumns.map((column) => `"${column}"`).join(", ");
  const rows = await exec(`/* carve-out:verify-projection */
    WITH source_duplicate_keys AS (
      SELECT ${groupedKeys} FROM ${source}
       GROUP BY ${groupedKeys} HAVING COUNT(*) > 1
    ), target_duplicate_keys AS (
      SELECT ${groupedKeys} FROM ${target}
       GROUP BY ${groupedKeys} HAVING COUNT(*) > 1
    )
    SELECT
      COUNT(*) FILTER (WHERE ${targetAbsent})::text AS missing_count,
      COUNT(*) FILTER (
        WHERE NOT (${targetAbsent})
          AND NOT (to_jsonb(t) @> to_jsonb(s))
      )::text AS conflict_count,
      (SELECT COUNT(*)::text FROM ${source} AS s WHERE ${sourceKeyNull}) AS source_null_key_count,
      (SELECT COUNT(*)::text FROM ${target} AS t WHERE ${targetKeyNull}) AS target_null_key_count,
      (SELECT COUNT(*)::text FROM source_duplicate_keys) AS source_duplicate_key_count,
      (SELECT COUNT(*)::text FROM target_duplicate_keys) AS target_duplicate_key_count
      FROM ${source} AS s
      LEFT JOIN ${target} AS t ON ${keyJoin}`);
  if (rows.length !== 1) {
    throw new ElizaError("Carve-out migration verification returned an invalid row count", {
      code: "CARVE_OUT_MIGRATION_VERIFICATION_INVALID",
      context: { migrationKey: options.migrationKey, rowCount: rows.length },
      severity: "fatal",
    });
  }
  const keyIssues = {
    sourceNull: countValue(rows[0], "source_null_key_count"),
    targetNull: countValue(rows[0], "target_null_key_count"),
    sourceDuplicates: countValue(rows[0], "source_duplicate_key_count"),
    targetDuplicates: countValue(rows[0], "target_duplicate_key_count"),
  };
  if (Object.values(keyIssues).some((count) => count > 0)) {
    throw new ElizaError("Carve-out migration key columns are null or ambiguous", {
      code: "CARVE_OUT_MIGRATION_KEY_INVALID",
      context: { migrationKey: options.migrationKey, ...keyIssues },
      severity: "fatal",
    });
  }
  const conflicts = countValue(rows[0], "conflict_count");
  const missing = countValue(rows[0], "missing_count");
  if (conflicts > 0) {
    throw new ElizaError("Carve-out migration found same-key rows with different values", {
      code: "CARVE_OUT_MIGRATION_COLLISION",
      context: { migrationKey: options.migrationKey, conflicts },
      severity: "fatal",
    });
  }
  if (missing > 0) {
    throw new ElizaError("Carve-out migration left source rows absent from the target", {
      code: "CARVE_OUT_MIGRATION_INCOMPLETE",
      context: { migrationKey: options.migrationKey, missing },
      severity: "fatal",
    });
  }
}

async function ensureReceiptTable(exec: CarveOutSqlExecutor): Promise<void> {
  await exec(`CREATE SCHEMA IF NOT EXISTS ${RECEIPT_SCHEMA}`);
  await exec(`CREATE TABLE IF NOT EXISTS ${RECEIPT_SCHEMA}.${RECEIPT_TABLE} (
    migration_key TEXT PRIMARY KEY,
    holder_token TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    outcome TEXT
  )`);
}

function sourceLockStatement(sources: ReadonlyArray<{ schema: string; table: string }>): string {
  const locks = sources
    .map((source) => {
      const table = qualifiedTable(source.schema, source.table);
      const regclass = `${source.schema}.${source.table}`;
      return `IF to_regclass(${literal(regclass)}) IS NOT NULL THEN
        EXECUTE ${literal(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`)};
      END IF;`;
    })
    .join("\n");
  return `/* carve-out:lock-sources */
    DO $carve_out_source_lock$
    BEGIN
      ${locks}
    END
    $carve_out_source_lock$`;
}

/**
 * Run a domain migration under a durable lease and completion receipt.
 *
 * The claim, source lock, domain callback, verification, and completion update
 * share one transaction. Callback failure rolls back both copied rows and the
 * uncommitted claim, while the receipt primary key serializes concurrent
 * attempts. A pre-existing committed `running` receipt is treated as an
 * invalid legacy/operator state and fails startup closed.
 */
export async function runCarveOutMigration<T>(
  database: CarveOutDatabase,
  options: {
    key: string;
    sourceTables: ReadonlyArray<{ schema: string; table: string }>;
    run: (execute: CarveOutSqlExecutor) => Promise<T>;
    outcome: (value: T) => string;
    shouldComplete?: (value: T) => boolean;
  }
): Promise<CarveOutRunResult<T>> {
  await ensureReceiptTable(database.execute);
  const holderToken = globalThis.crypto.randomUUID();
  return database.transaction(async (exec) => {
    const claimed = await exec(`/* carve-out:claim */
    INSERT INTO ${RECEIPT_SCHEMA}.${RECEIPT_TABLE}
      (migration_key, holder_token, status, started_at, completed_at, outcome)
    VALUES (${literal(options.key)}, ${literal(holderToken)}, 'running', now(), NULL, NULL)
    ON CONFLICT (migration_key) DO NOTHING
    RETURNING holder_token`);
    if (String(firstValue(claimed[0]) ?? "") !== holderToken) {
      const rows = await exec(`/* carve-out:status */
      SELECT status FROM ${RECEIPT_SCHEMA}.${RECEIPT_TABLE}
       WHERE migration_key = ${literal(options.key)}`);
      const status = rows.length === 1 ? firstValue(rows[0]) : undefined;
      if (status === "completed") return { status: "already-completed" };
      if (status === "running") {
        throw new ElizaError(
          "Carve-out migration is already running; startup cannot continue before its data copy completes",
          {
            code: "CARVE_OUT_MIGRATION_IN_PROGRESS",
            context: { migrationKey: options.key },
            severity: "fatal",
          }
        );
      }
      throw new ElizaError("Carve-out migration receipt is unreadable", {
        code: "CARVE_OUT_MIGRATION_RECEIPT_INVALID",
        context: {
          migrationKey: options.key,
          rowCount: rows.length,
          status,
        },
        severity: "fatal",
      });
    }

    try {
      await exec(sourceLockStatement(options.sourceTables));
      const value = await options.run(exec);
      if (options.shouldComplete && !options.shouldComplete(value)) {
        await exec(`/* carve-out:release */
        DELETE FROM ${RECEIPT_SCHEMA}.${RECEIPT_TABLE}
         WHERE migration_key = ${literal(options.key)}
           AND holder_token = ${literal(holderToken)}
           AND status = 'running'`);
        return { status: "completed", value };
      }
      const completed = await exec(`/* carve-out:complete */
      UPDATE ${RECEIPT_SCHEMA}.${RECEIPT_TABLE}
         SET status = 'completed', completed_at = now(), outcome = ${literal(options.outcome(value))}
       WHERE migration_key = ${literal(options.key)}
         AND holder_token = ${literal(holderToken)}
         AND status = 'running'
       RETURNING migration_key`);
      if (completed.length !== 1) {
        throw new Error(`Carve-out migration lease was lost: ${options.key}`);
      }
      return { status: "completed", value };
    } catch (error) {
      try {
        await exec(`/* carve-out:release */
          DELETE FROM ${RECEIPT_SCHEMA}.${RECEIPT_TABLE}
           WHERE migration_key = ${literal(options.key)}
             AND holder_token = ${literal(holderToken)}
             AND status = 'running'`);
      } catch {
        // error-policy:J6 transaction rollback remains authoritative if cleanup also fails.
      }
      throw error;
    }
  });
}
