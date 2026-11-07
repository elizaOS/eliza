/** SQLite persistence for the existing message-interaction commitment protocol.
 * The host supplies a private durable connection; no transaction may be open
 * when invoking this store. Effects only run after commitIfClaimed resolves.
 */

import {
  applyMessageInteractionClaim,
  applyMessageInteractionCommit,
  applyMessageInteractionCompletion,
  applyMessageInteractionReconciliation,
  applyMessageInteractionRevocation,
  type MessageInteractionClaimContext,
  type MessageInteractionClaimResult,
  type MessageInteractionCommitContext,
  type MessageInteractionCompleteContext,
  type MessageInteractionReconcileContext,
  type MessageInteractionSession,
  type MessageInteractionSessionStore,
} from "@elizaos/core";
import { ElizaError } from "@elizaos/core/protocol";
import type { TaskSqliteConnection } from "./interactive-task-store.ts";
import {
  structurallyValidSession,
  validBoundedJson,
} from "./message-interaction-validation.ts";

function fail(code: string): never {
  throw new ElizaError("Interaction journal rejected the operation", { code });
}
function clock(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 8_640_000_000_000_000
  )
    fail("INVALID_MESSAGE_INTERACTION_CLOCK");
}
function checked(value: unknown, reference: string): MessageInteractionSession {
  if (!validBoundedJson(value) || !structurallyValidSession(value, reference))
    fail("MESSAGE_INTERACTION_STORAGE_CORRUPT");
  return value as MessageInteractionSession;
}

export class SqliteMessageInteractionSessionStore
  implements MessageInteractionSessionStore
{
  constructor(private readonly db: TaskSqliteConnection) {
    const mode = db.prepare("PRAGMA synchronous").get() as
      | { synchronous?: number }
      | undefined;
    if (!mode || ![2, 3].includes(Number(mode.synchronous)))
      fail("MESSAGE_INTERACTION_STORAGE_NOT_DURABLE");
    db.exec(`CREATE TABLE IF NOT EXISTS message_interaction_sessions_v1 (
      reference TEXT PRIMARY KEY NOT NULL, document TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS message_interaction_committed_v1 ON message_interaction_sessions_v1
      (json_extract(document, '$.consume.state'), json_extract(document, '$.consume.committedAt'));`);
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private read(reference: string): MessageInteractionSession | null {
    const row = this.db
      .prepare(
        "SELECT document FROM message_interaction_sessions_v1 WHERE reference = ?",
      )
      .get(reference) as { document?: unknown } | undefined;
    if (!row) return null;
    if (typeof row.document !== "string")
      fail("MESSAGE_INTERACTION_STORAGE_CORRUPT");
    let value: unknown;
    try {
      value = JSON.parse(row.document);
    } catch {
      fail("MESSAGE_INTERACTION_STORAGE_CORRUPT");
    }
    return checked(value, reference);
  }
  private change<T>(
    reference: string,
    apply: (session: MessageInteractionSession) => {
      session: MessageInteractionSession;
      result: T;
    },
  ): T {
    return this.transaction(() => {
      const current = this.read(reference);
      if (!current) fail("MESSAGE_INTERACTION_NOT_FOUND");
      const { session, result } = apply(current);
      checked(session, reference);
      this.db
        .prepare(
          "UPDATE message_interaction_sessions_v1 SET document = ? WHERE reference = ?",
        )
        .run(JSON.stringify(session), reference);
      return result;
    });
  }
  async create(session: MessageInteractionSession): Promise<void> {
    checked(session, session.reference);
    if (
      session.revision !== 0 ||
      session.consume.state !== "pending" ||
      session.authorization.state !== "active"
    )
      fail("INVALID_MESSAGE_INTERACTION_INITIAL_STATE");
    this.transaction(() => {
      if (this.read(session.reference))
        fail("MESSAGE_INTERACTION_ALREADY_EXISTS");
      this.db
        .prepare(
          "INSERT INTO message_interaction_sessions_v1 (reference, document) VALUES (?, ?)",
        )
        .run(session.reference, JSON.stringify(session));
    });
  }
  async get(reference: string): Promise<MessageInteractionSession | null> {
    return this.read(reference);
  }
  async claimIfCurrent(
    context: MessageInteractionClaimContext,
  ): Promise<MessageInteractionClaimResult> {
    return this.change(context.reference, (current) => {
      const result = applyMessageInteractionClaim(current, context);
      return { session: result.session, result };
    });
  }
  async commitIfClaimed(
    context: MessageInteractionCommitContext,
  ): Promise<MessageInteractionSession> {
    return this.change(context.reference, (current) => {
      clock(context.now);
      // A claim does not extend the original user-response window or its lease.
      if (
        current.consume.state === "claimed" &&
        (Date.parse(current.consume.claimExpiresAt) <= context.now ||
          Date.parse(current.expiresAt) <= context.now)
      )
        fail("MESSAGE_INTERACTION_EXPIRED");
      const session = applyMessageInteractionCommit(current, context);
      return { session, result: session };
    });
  }
  async completeIfClaimed(
    context: MessageInteractionCompleteContext,
  ): Promise<MessageInteractionSession> {
    return this.change(context.reference, (current) => {
      const session = applyMessageInteractionCompletion(current, context);
      return { session, result: session };
    });
  }
  async reconcileCommitted(
    context: MessageInteractionReconcileContext,
  ): Promise<MessageInteractionSession> {
    return this.change(context.reference, (current) => {
      const session = applyMessageInteractionReconciliation(current, context);
      return { session, result: session };
    });
  }
  async revokeAuthorization(args: {
    reference: string;
    decisionId: string;
    now: number;
  }): Promise<MessageInteractionSession> {
    return this.change(args.reference, (current) => {
      const session = applyMessageInteractionRevocation(
        current,
        args.decisionId,
        args.now,
      );
      return { session, result: session };
    });
  }
  async listCommitted(args: {
    committedBefore: number;
    limit: number;
  }): Promise<MessageInteractionSession[]> {
    clock(args.committedBefore);
    if (
      !Number.isSafeInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > 1000
    )
      fail("INVALID_MESSAGE_INTERACTION_LIMIT");
    const row = this.db
      .prepare(`SELECT json_group_array(json(document)) AS documents FROM
      (SELECT document FROM message_interaction_sessions_v1 WHERE json_extract(document, '$.consume.state') = 'committed'
      AND json_extract(document, '$.consume.committedAt') <= ? ORDER BY json_extract(document, '$.consume.committedAt'), reference LIMIT ?)`)
      .get(new Date(args.committedBefore).toISOString(), args.limit) as {
      documents: string;
    };
    const values = JSON.parse(row.documents) as MessageInteractionSession[];
    return values.map((value) => checked(value, value.reference));
  }
  async deleteExpired(before: number): Promise<number> {
    clock(before);
    return this.transaction(() => {
      // Committed outcomes are permanently ambiguous until explicitly reconciled.
      // Never let retention turn a missing receipt into permission to execute again.
      this.db
        .prepare(`DELETE FROM message_interaction_sessions_v1 WHERE
        (json_extract(document, '$.consume.state') = 'completed' AND json_extract(document, '$.consume.completedAt') <= ?)
        OR (json_extract(document, '$.consume.state') IN ('pending','claimed') AND json_extract(document, '$.expiresAt') <= ?)`)
        .run(new Date(before).toISOString(), new Date(before).toISOString());
      const row = this.db.prepare("SELECT changes() AS count").get() as {
        count: number;
      };
      return row.count;
    });
  }
}
