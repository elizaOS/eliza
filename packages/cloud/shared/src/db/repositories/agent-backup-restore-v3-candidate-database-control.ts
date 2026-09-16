/** Transaction-local deadline controls for restore-v3 candidate repositories. */

import type { AgentBackupRestoreV3OperationControl } from "@elizaos/shared";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { isTransientDbError } from "../retry-transient";

const MIN_DATABASE_TIMEOUT_MS = 1;
const MAX_DATABASE_TIMEOUT_MS = 2_147_483_647;
const DATABASE_DEADLINE_SQL_STATES = new Set(["55P03", "57014"]);

function abortError(operation: string, cause?: unknown): DOMException {
  const error = new DOMException(
    `${operation} was cancelled or exceeded its deadline`,
    "AbortError",
  );
  if (cause !== undefined) {
    Object.defineProperty(error, "cause", { configurable: true, value: cause });
  }
  return error;
}

/** Snapshot caller-owned control fields once while preserving live abort semantics. */
export function snapshotAgentBackupRestoreV3OperationControl(
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): Readonly<AgentBackupRestoreV3OperationControl> {
  return Object.freeze({
    signal: control.signal,
    deadlineEpochMs: control.deadlineEpochMs,
  });
}

export function assertAgentBackupRestoreV3OperationControl(
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  operation: string,
): void {
  if (
    !Number.isSafeInteger(control.deadlineEpochMs) ||
    control.deadlineEpochMs <= 0 ||
    control.signal.aborted ||
    Date.now() >= control.deadlineEpochMs
  ) {
    throw abortError(operation);
  }
}

/**
 * Bound every statement and lock wait in this transaction to the caller's
 * remaining deadline. Expired deadlines fail before the first durable write;
 * a positive timeout is never manufactured for an already-expired operation.
 */
export async function applyAgentBackupRestoreV3TransactionDeadline(
  tx: DbTransaction,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  operation: string,
): Promise<void> {
  assertAgentBackupRestoreV3OperationControl(control, operation);
  const remainingMs = Math.floor(control.deadlineEpochMs - Date.now());
  if (remainingMs < MIN_DATABASE_TIMEOUT_MS) throw abortError(operation);
  const timeoutMs = Math.min(remainingMs, MAX_DATABASE_TIMEOUT_MS);
  await tx.execute(sql`SELECT
    set_config('statement_timeout', ${`${timeoutMs}ms`}, TRUE),
    set_config('lock_timeout', ${`${timeoutMs}ms`}, TRUE)`);
  assertAgentBackupRestoreV3OperationControl(control, operation);
}

export function agentBackupRestoreV3DatabaseSqlState(cause: unknown): string | undefined {
  let current = cause;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** 57014 (statement cancel) and 55P03 (lock timeout) are fail-closed deadlines. */
export function throwIfAgentBackupRestoreV3DatabaseDeadline(
  cause: unknown,
  operation: string,
): void {
  if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
  const sqlState = agentBackupRestoreV3DatabaseSqlState(cause);
  if (sqlState && DATABASE_DEADLINE_SQL_STATES.has(sqlState)) {
    throw abortError(operation, cause);
  }
}

/** Only connection loss or admin shutdown can make COMMIT acknowledgement ambiguous. */
export function isAgentBackupRestoreV3AmbiguousCommitResponse(cause: unknown): boolean {
  const sqlState = agentBackupRestoreV3DatabaseSqlState(cause);
  if (sqlState !== undefined) return sqlState.startsWith("08") || sqlState === "57P01";
  return isTransientDbError(cause);
}
