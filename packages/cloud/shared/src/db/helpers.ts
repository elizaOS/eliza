/**
 * Read/write database access for repositories and services: the read-intent
 * connection (`dbRead`), the primary connection (`dbWrite`), and the
 * `writeTransaction` wrapper that runs a transaction on the primary with
 * observability. Consumed across `db/repositories/*` and `lib/services/*`,
 * which import `dbRead` / `dbWrite` / `writeTransaction` directly.
 */

import { observeDbOperation } from "../lib/observability/cloud-backend-observability";
import {
  type Database,
  type DbTransaction,
  db,
  dbRead,
  dbWrite,
  getDbConnectionInfo,
} from "./client";

// ============================================================================
// Transaction Helpers
// ============================================================================

/**
 * Execute a write transaction
 * Transactions always use the primary database
 *
 * @example
 * await writeTransaction(async (tx) => {
 *   await tx.insert(users).values(userData);
 *   await tx.insert(credits).values(creditData);
 * });
 */
export async function writeTransaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
  return observeDbOperation("transaction", "writeTransaction", () => dbWrite.transaction(fn));
}

// ============================================================================
// Re-exports for convenience
// ============================================================================

export type { Database };
export { db, dbRead, dbWrite, getDbConnectionInfo };
