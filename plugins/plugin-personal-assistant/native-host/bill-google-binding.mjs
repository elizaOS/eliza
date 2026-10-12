import { randomUUID } from "node:crypto";
import { BillHostError } from "./errors.mjs";

const ownerKey = (owner) =>
  JSON.stringify([
    owner.agentId,
    owner.actorId,
    owner.connector.source,
    owner.connector.accountId,
  ]);
const unavailable = () => {
  throw new BillHostError("Original Google account unavailable");
};

/** Task-owned source identity, not a credential or an authorization grant. */
export function createBillGoogleBinding({ db, store }) {
  const session = randomUUID();
  // No backfill: an existing task with no record has unknown original identity.
  // New task creation and its marker commit or roll back in one transaction.
  db.exec(`CREATE TABLE IF NOT EXISTS bill_google_binding_v1 (
    task_id TEXT PRIMARY KEY NOT NULL, owner_key TEXT NOT NULL,
    session TEXT NOT NULL, account_id TEXT, email TEXT,
    CHECK (account_id IS NOT NULL OR email IS NULL)
  );
  DROP TRIGGER IF EXISTS bill_google_binding_create_v1;
  CREATE TRIGGER bill_google_binding_create_v1 AFTER INSERT ON interactive_task_journal_v1
  BEGIN INSERT INTO bill_google_binding_v1 (task_id, owner_key, session)
    VALUES (new.id, new.owner_key, '${session}'); END;
  CREATE TRIGGER IF NOT EXISTS bill_google_binding_delete_v1 AFTER DELETE ON interactive_task_journal_v1
  BEGIN DELETE FROM bill_google_binding_v1 WHERE task_id = old.id AND owner_key = old.owner_key; END;`);
  const current = (task) => {
    const saved = store.get(task.id, task.owner);
    if (
      !saved ||
      saved.epoch !== task.epoch ||
      saved.revision !== task.revision
    )
      unavailable();
    const row = db
      .prepare(
        "SELECT * FROM bill_google_binding_v1 WHERE task_id = ? AND owner_key = ?",
      )
      .get(task.id, ownerKey(task.owner));
    if (
      !row ||
      (row.account_id !== null &&
        (typeof row.account_id !== "string" || !row.account_id.trim())) ||
      (row.email !== null &&
        (typeof row.email !== "string" || !row.email.trim())) ||
      (row.account_id === null &&
        (row.email !== null || row.session !== session))
    )
      unavailable();
    return row;
  };
  const identity = (row) =>
    row.account_id === null
      ? null
      : {
          accountId: row.account_id,
          ...(row.email !== null ? { email: row.email } : {}),
        };
  return {
    read(task) {
      return identity(current(task));
    },
    bind(task, account) {
      if (
        typeof account?.accountId !== "string" ||
        !account.accountId.trim() ||
        (account.email !== undefined &&
          (typeof account.email !== "string" || !account.email.trim()))
      )
        unavailable();
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = current(task);
        if (row.account_id === null)
          db.prepare(
            "UPDATE bill_google_binding_v1 SET account_id = ?, email = ? WHERE task_id = ? AND owner_key = ? AND account_id IS NULL",
          ).run(
            account.accountId,
            account.email ?? null,
            task.id,
            ownerKey(task.owner),
          );
        const result = identity(current(task));
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
