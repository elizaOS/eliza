/**
 * Durable orchestration for one-time plugin table carve-outs.
 *
 * Domain plugins retain their explicit copy/repair SQL. This module owns the
 * shared receipt claim so repeated or concurrent startup cannot replay a
 * completed legacy import after an owner deletes data from the new table.
 */

import { ElizaError } from "@elizaos/core";

export type CarveOutSqlExecutor = (statement: string) => Promise<Array<Record<string, unknown>>>;

export type CarveOutRunResult<T> =
  | { status: "completed"; value: T }
  | { status: "already-completed" };

const RECEIPT_SCHEMA = "app_eliza_migrations";
const RECEIPT_TABLE = "carve_out_receipts";

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function firstValue(row: Record<string, unknown> | undefined): unknown {
  return row ? Object.values(row)[0] : undefined;
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

/**
 * Run a domain migration under a durable lease and completion receipt.
 *
 * A failed callback removes only its own claim, allowing the next boot to
 * retry an idempotent domain copy. A running receipt is never taken over
 * automatically: callback duration is unbounded, so elapsed time cannot prove
 * that its owner is dead. Operators may remove an abandoned running receipt
 * only after establishing that its holder can no longer write. A competing
 * claim fails startup so no runtime can write the target tables before the
 * owning copy completes.
 */
export async function runCarveOutMigration<T>(
  exec: CarveOutSqlExecutor,
  options: {
    key: string;
    run: () => Promise<T>;
    outcome: (value: T) => string;
    shouldComplete?: (value: T) => boolean;
  }
): Promise<CarveOutRunResult<T>> {
  await ensureReceiptTable(exec);
  const holderToken = globalThis.crypto.randomUUID();
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
    const value = await options.run();
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
      // error-policy:J6 best-effort teardown — cleanup failure must not mask the migration failure.
    }
    throw error;
  }
}
