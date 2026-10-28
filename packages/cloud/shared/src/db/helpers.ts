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
const commitCallbacks = new WeakMap<
  DbTransaction,
  { before: Array<() => Promise<void>>; after: Array<() => Promise<void>> }
>();

export function registerBeforeCommit(tx: DbTransaction, callback: () => Promise<void>): void {
  const callbacks = commitCallbacks.get(tx)?.before;
  if (!callbacks) throw new UnmanagedWriteTransactionError();
  callbacks.push(callback);
}

/** Register effects on the exact managed transaction; never run them before COMMIT. */
export function registerAfterCommit(tx: DbTransaction, callback: () => Promise<void>): void {
  const callbacks = commitCallbacks.get(tx)?.after;
  if (!callbacks) {
    throw new UnmanagedWriteTransactionError();
  }
  callbacks.push(callback);
}

export class UnmanagedWriteTransactionError extends Error {
  constructor() {
    super("Policy mutation requires a managed writeTransaction transaction");
    this.name = "UnmanagedWriteTransactionError";
  }
}

export async function writeTransaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
  const callbacks: Array<() => Promise<void>> = [];
  const result = await observeDbOperation("transaction", "writeTransaction", () =>
    dbWrite.transaction(async (tx) => {
      const beforeCommit: Array<() => Promise<void>> = [];
      commitCallbacks.set(tx, { before: beforeCommit, after: callbacks });
      try {
        const result = await fn(tx);
        for (const callback of beforeCommit) await callback();
        return result;
      } finally {
        commitCallbacks.delete(tx);
      }
    }),
  );
  // COMMIT has succeeded. A publication failure must remain visible to the caller.
  const effects = await Promise.allSettled(callbacks.map((callback) => callback()));
  for (const effect of effects) {
    if (effect.status === "rejected") throw effect.reason;
  }
  return result;
}

// ============================================================================
// Re-exports for convenience
// ============================================================================

export type { Database };
export { db, dbRead, dbWrite, getDbConnectionInfo };
