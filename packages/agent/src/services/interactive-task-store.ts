/** Durable task journal on a host-supplied SQLite connection.
 * The host owns database location, encryption, migrations and authenticated owner
 * resolution. No raw page text, credentials or secret values belong in this store.
 * Each method is synchronous: an effect may start only after transition returns.
 */

import {
  createInteractiveTask,
  ElizaError,
  type InteractiveTask,
  sameTaskOwner,
  type TaskContext,
  type TaskEvent,
  type TaskOwner,
  type TaskTransition,
  transitionInteractiveTask,
  validateInteractiveTask,
  validateTaskEvent,
} from "@elizaos/core/protocol";

export interface TaskSqliteConnection {
  exec(sql: string): unknown;
  prepare(sql: string): {
    get(...parameters: (string | number)[]): unknown;
    run(...parameters: (string | number)[]): unknown;
  };
}

/** Journal rows recovery reads at a time. */
const RECOVERY_PAGE = 64;

function ownerKey(owner: TaskOwner): string {
  return JSON.stringify([
    owner.agentId,
    owner.actorId,
    owner.connector.source,
    owner.connector.accountId,
  ]);
}
function fail(message: string, code: string): never {
  throw new ElizaError(message, { code });
}
function parse(document: unknown): InteractiveTask {
  if (typeof document !== "string")
    fail("Invalid persisted task row", "TASK_STORAGE_CORRUPT");
  try {
    return JSON.parse(document) as InteractiveTask;
  } catch {
    fail("Invalid persisted task JSON", "TASK_STORAGE_CORRUPT");
  }
}
function decode(row: unknown): InteractiveTask | null {
  if (row === undefined || row === null) return null;
  if (typeof row !== "object" || !("document" in row))
    fail("Invalid persisted task row", "TASK_STORAGE_CORRUPT");
  const value = parse(row.document);
  validateInteractiveTask(value);
  return value;
}
/** Why a record is valid JSON but not a task this build can read, such as one
 * written by an older or newer build. A torn row is not quarantined: it stays
 * corrupt and fails where it is read. */
function unreadableReason(document: unknown): string | null {
  try {
    validateInteractiveTask(parse(document));
  } catch (error) {
    if (error instanceof ElizaError && error.code === "TASK_INVALID")
      return error.message;
  }
  return null;
}
function readable(document: unknown): boolean {
  try {
    validateInteractiveTask(parse(document));
    return true;
  } catch {
    return false;
  }
}
const UNRESOLVED = ["prepared", "dispatched", "unknown"];

/** A task record this build could not read; its document stays in the journal. */
export interface UnreadableTaskRecord {
  taskId: string;
  reason: string;
  quarantinedAt: number;
  /** Set once the owner released the slot the record held. */
  acknowledgedAt: number | null;
}

/** The owner accepted that this operation's outcome stays unknown. */
export interface UnknownOutcomeAcknowledgement {
  operationId: string;
  acknowledgedAt: number;
}

export class SqliteInteractiveTaskStore {
  constructor(private readonly db: TaskSqliteConnection) {
    const mode = db.prepare("PRAGMA synchronous").get();
    if (
      !mode ||
      typeof mode !== "object" ||
      !("synchronous" in mode) ||
      Number(mode.synchronous) < 2
    )
      fail(
        "Task journal requires FULL or EXTRA SQLite synchronization",
        "TASK_STORAGE_NOT_DURABLE",
      );
    // A host connection must not be shared with an open transaction while calling
    // this store. BEGIN IMMEDIATE provides cross-process writer serialization.
    db.exec(`CREATE TABLE IF NOT EXISTS interactive_task_journal_v1 (
      id TEXT PRIMARY KEY NOT NULL,
      owner_key TEXT NOT NULL,
      unfinished INTEGER NOT NULL CHECK (unfinished IN (0, 1)),
      document TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS interactive_task_one_unfinished_v1
      ON interactive_task_journal_v1(owner_key) WHERE unfinished = 1;
    CREATE TABLE IF NOT EXISTS interactive_task_events_v1 (
      task_id TEXT NOT NULL, owner_key TEXT NOT NULL, sequence INTEGER NOT NULL,
      document TEXT NOT NULL, PRIMARY KEY(task_id, sequence));
    CREATE TABLE IF NOT EXISTS interactive_task_unknown_acknowledgements_v1 (
      task_id TEXT NOT NULL, owner_key TEXT NOT NULL, operation_id TEXT NOT NULL,
      acknowledged_at INTEGER NOT NULL, PRIMARY KEY(task_id, operation_id));
    CREATE TABLE IF NOT EXISTS interactive_task_quarantine_v1 (
      task_id TEXT PRIMARY KEY NOT NULL, owner_key TEXT NOT NULL,
      reason TEXT NOT NULL, quarantined_at INTEGER NOT NULL,
      acknowledged_at INTEGER);
    INSERT OR IGNORE INTO interactive_task_events_v1 (task_id, owner_key, sequence, document)
      SELECT id, owner_key, json_extract(document, '$.revision'),
        json_object('schemaVersion', 1, 'eventId', id || '#' || json_extract(document, '$.revision'),
          'taskId', id, 'sequence', json_extract(document, '$.revision'),
          'epoch', json_extract(document, '$.epoch'), 'kind', 'checkpoint',
          'at', json_extract(document, '$.updatedAt'), 'status', json_extract(document, '$.status'))
      FROM interactive_task_journal_v1 AS tasks
      WHERE NOT EXISTS (SELECT 1 FROM interactive_task_events_v1 AS events WHERE events.task_id = tasks.id);`);
  }

  private appendEvent(owner: TaskOwner, event: TaskEvent): void {
    validateTaskEvent(event);
    this.db
      .prepare(
        "INSERT INTO interactive_task_events_v1 (task_id, owner_key, sequence, document) VALUES (?, ?, ?, ?)",
      )
      .run(
        event.taskId,
        ownerKey(owner),
        event.sequence,
        JSON.stringify(event),
      );
  }

  /** Bounded transport pages, not truncated history. The caller follows hasMore. */
  events(
    id: string,
    owner: TaskOwner,
    afterSequence = -1,
  ): {
    events: TaskEvent[];
    cursor: number;
    hasMore: boolean;
    task: InteractiveTask;
    /** Operations whose unknown outcome the owner accepted, and when. */
    acknowledgements: UnknownOutcomeAcknowledgement[];
  } {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < -1)
      fail("Invalid event cursor", "TASK_INVALID");
    return this.transaction(() => {
      const task = this.get(id, owner);
      if (!task) fail("Task not found for this owner", "TASK_NOT_FOUND");
      if (afterSequence > task.revision)
        fail("Event cursor is ahead of task", "TASK_INVALID");
      const row = this.db
        .prepare(
          "SELECT json_group_array(json(document)) AS documents FROM (SELECT document FROM interactive_task_events_v1 WHERE task_id = ? AND owner_key = ? AND sequence > ? ORDER BY sequence LIMIT 129)",
        )
        .get(id, ownerKey(owner), afterSequence) as { documents?: unknown };
      if (!row || typeof row.documents !== "string")
        fail("Invalid event records", "TASK_STORAGE_CORRUPT");
      const values = JSON.parse(row.documents) as TaskEvent[];
      if (!Array.isArray(values))
        fail("Invalid event records", "TASK_STORAGE_CORRUPT");
      let previous = afterSequence;
      for (const event of values) {
        validateTaskEvent(event);
        if (
          event.taskId !== id ||
          event.sequence <= previous ||
          event.sequence > task.revision ||
          (event.sequence !== previous + 1 &&
            !(previous === -1 && event.kind === "checkpoint"))
        )
          fail("Task event history has a gap", "TASK_STORAGE_CORRUPT");
        previous = event.sequence;
      }
      if (values.length === 0 && afterSequence < task.revision)
        fail("Task event history is missing", "TASK_STORAGE_CORRUPT");
      if (values.length <= 128 && previous < task.revision)
        fail("Task event history is incomplete", "TASK_STORAGE_CORRUPT");
      const events = values.slice(0, 128);
      return {
        events,
        cursor: events.at(-1)?.sequence ?? afterSequence,
        hasMore: values.length > 128,
        task,
        acknowledgements: this.acknowledgements(id, owner),
      };
    });
  }

  private acknowledgements(
    id: string,
    owner: TaskOwner,
  ): UnknownOutcomeAcknowledgement[] {
    const row = this.db
      .prepare(
        "SELECT json_group_array(json_object('operationId', operation_id, 'acknowledgedAt', acknowledged_at)) AS rows FROM (SELECT * FROM interactive_task_unknown_acknowledgements_v1 WHERE task_id = ? AND owner_key = ? ORDER BY acknowledged_at, operation_id)",
      )
      .get(id, ownerKey(owner)) as { rows: string };
    return JSON.parse(row.rows) as UnknownOutcomeAcknowledgement[];
  }

  /** Complete bounded history for synchronous host evidence projection.
   * Uses existing page transactions; callbacks must be read-only and synchronous.
   * Any observed database change invalidates the result rather than publishing a partial cohort.
   */
  readOwnerHistory<T>(
    owner: TaskOwner,
    limits: { maxTasks: number; maxEvents: number },
    inspect: (histories: { task: InteractiveTask; events: TaskEvent[] }[]) => T,
  ): T {
    const { maxTasks, maxEvents } = limits;
    if (
      !Number.isSafeInteger(maxTasks) ||
      maxTasks < 1 ||
      maxTasks >= 0x7fffffff ||
      !Number.isSafeInteger(maxEvents) ||
      maxEvents < 1 ||
      maxEvents >= 0x7fffffff
    )
      fail("Invalid task history limits", "TASK_INVALID");
    const mark = () => {
      const version = this.db.prepare("PRAGMA data_version").get() as {
        data_version: number;
      };
      const changes = this.db
        .prepare("SELECT total_changes() AS changes")
        .get() as { changes: number };
      const schema = this.db.prepare("PRAGMA schema_version").get() as {
        schema_version: number;
      };
      const values = [
        version?.data_version,
        changes?.changes,
        schema?.schema_version,
      ];
      if (values.some((value) => !Number.isSafeInteger(value) || value < 0))
        fail("Invalid task history snapshot", "TASK_STORAGE_CORRUPT");
      return JSON.stringify(values);
    };
    const before = mark();
    const row = this.db
      .prepare(
        "SELECT json_group_array(id) AS ids FROM (SELECT id FROM interactive_task_journal_v1 WHERE owner_key=? AND id NOT IN (SELECT task_id FROM interactive_task_quarantine_v1) ORDER BY id LIMIT ?)",
      )
      .get(ownerKey(owner), maxTasks + 1) as { ids: string };
    const ids: unknown = JSON.parse(row.ids);
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
      fail("Invalid task history index", "TASK_STORAGE_CORRUPT");
    if (ids.length > maxTasks)
      fail("Task history exceeds limit", "TASK_HISTORY_LIMIT");
    const histories: { task: InteractiveTask; events: TaskEvent[] }[] = [];
    let remaining = maxEvents;
    for (const id of ids) {
      let cursor = -1;
      let task: InteractiveTask | undefined;
      const events: TaskEvent[] = [];
      for (;;) {
        const page = this.events(id, owner, cursor);
        if (task && task.revision !== page.task.revision)
          fail("Task history changed during read", "TASK_HISTORY_CHANGED");
        task = page.task;
        remaining -= page.events.length;
        if (remaining < 0)
          fail("Task history exceeds limit", "TASK_HISTORY_LIMIT");
        events.push(...page.events);
        cursor = page.cursor;
        if (!page.hasMore) break;
      }
      histories.push({ task, events });
    }
    const result = inspect(histories);
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      typeof (result as { then?: unknown }).then === "function"
    )
      fail("Task history projection must be synchronous", "TASK_INVALID");
    if (mark() !== before)
      fail("Task history changed during read", "TASK_HISTORY_CHANGED");
    return result;
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (cause) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackCause) {
        throw new ElizaError(
          "Task transaction rollback failed; discard this connection",
          {
            code: "TASK_STORAGE_UNCERTAIN",
            cause: rollbackCause,
          },
        );
      }
      throw cause;
    }
  }

  get(id: string, owner: TaskOwner): InteractiveTask | null {
    const row = this.db
      .prepare(
        "SELECT document, EXISTS (SELECT 1 FROM interactive_task_quarantine_v1 WHERE task_id = tasks.id) AS quarantined FROM interactive_task_journal_v1 AS tasks WHERE id = ? AND owner_key = ?",
      )
      .get(id, ownerKey(owner)) as
      | { document: unknown; quarantined: number }
      | undefined;
    if (row?.quarantined)
      fail(
        "This task record cannot be read by this version",
        "TASK_UNREADABLE",
      );
    const task = decode(row);
    if (task && (task.id !== id || !sameTaskOwner(task.owner, owner)))
      fail("Task row identity mismatch", "TASK_STORAGE_CORRUPT");
    return task;
  }

  /** The owner's readable unfinished task. An unreadable one is listed by `unreadable`. */
  getUnfinished(owner: TaskOwner): InteractiveTask | null {
    const task = decode(
      this.db
        .prepare(
          "SELECT document FROM interactive_task_journal_v1 WHERE owner_key = ? AND unfinished = 1 AND id NOT IN (SELECT task_id FROM interactive_task_quarantine_v1)",
        )
        .get(ownerKey(owner)),
    );
    if (task && !sameTaskOwner(task.owner, owner))
      fail("Task row identity mismatch", "TASK_STORAGE_CORRUPT");
    return task;
  }

  /** Set aside each of the owner's records this build cannot read, so one
   * record from another version never stops the host. Its document is kept
   * unchanged, and an unfinished one still holds the slot until the owner
   * acknowledges it. */
  private quarantineUnreadable(owner: TaskOwner, now: number): void {
    const key = ownerKey(owner);
    // A record set aside under another build, such as before a rollback was
    // undone, is a task again once this build can read it. An acknowledged one
    // gave up its slot, so it stays set aside.
    const held = this.db
      .prepare(
        "SELECT json_group_array(json_object('id', id, 'document', document)) AS rows FROM interactive_task_journal_v1 WHERE owner_key = ? AND id IN (SELECT task_id FROM interactive_task_quarantine_v1 WHERE owner_key = ? AND acknowledged_at IS NULL)",
      )
      .get(key, key) as { rows: string };
    for (const row of JSON.parse(held.rows) as {
      id: string;
      document: unknown;
    }[])
      if (readable(row.document))
        this.db
          .prepare(
            "DELETE FROM interactive_task_quarantine_v1 WHERE task_id = ? AND owner_key = ?",
          )
          .run(row.id, key);
    // The journal keeps every task the owner ever ran, so read it in id
    // pages: memory stays bounded however long the history grows.
    const page = this.db.prepare(
      "SELECT json_group_array(json_object('id', id, 'document', document)) AS rows FROM (SELECT id, document FROM interactive_task_journal_v1 WHERE owner_key = ? AND id > ? AND id NOT IN (SELECT task_id FROM interactive_task_quarantine_v1) ORDER BY id LIMIT ?)",
    );
    for (let afterId = ""; ; ) {
      const rows = JSON.parse(
        (page.get(key, afterId, RECOVERY_PAGE) as { rows: string }).rows,
      ) as { id: string; document: unknown }[];
      for (const row of rows) {
        const reason = unreadableReason(row.document);
        if (reason === null) continue;
        this.db
          .prepare(
            "INSERT INTO interactive_task_quarantine_v1 (task_id, owner_key, reason, quarantined_at) VALUES (?, ?, ?, ?)",
          )
          .run(row.id, key, reason, now);
      }
      if (rows.length < RECOVERY_PAGE) break;
      afterId = rows[rows.length - 1].id;
    }
  }

  unreadable(owner: TaskOwner): UnreadableTaskRecord[] {
    const row = this.db
      .prepare(
        "SELECT json_group_array(json_object('taskId', task_id, 'reason', reason, 'quarantinedAt', quarantined_at, 'acknowledgedAt', acknowledged_at)) AS records FROM (SELECT * FROM interactive_task_quarantine_v1 WHERE owner_key = ? ORDER BY quarantined_at, task_id)",
      )
      .get(ownerKey(owner)) as { records: string };
    return JSON.parse(row.records) as UnreadableTaskRecord[];
  }

  /** The owner releases the slot an unreadable record held. The record stays. */
  acknowledgeUnreadable(
    id: string,
    owner: TaskOwner,
    now: number,
  ): UnreadableTaskRecord[] {
    return this.transaction(() => {
      const key = ownerKey(owner);
      if (
        !this.db
          .prepare(
            "SELECT 1 AS pending FROM interactive_task_quarantine_v1 WHERE task_id = ? AND owner_key = ? AND acknowledged_at IS NULL",
          )
          .get(id, key)
      )
        fail("No unreadable task record to acknowledge", "TASK_NOT_FOUND");
      this.db
        .prepare(
          "UPDATE interactive_task_quarantine_v1 SET acknowledged_at = ? WHERE task_id = ? AND owner_key = ?",
        )
        .run(now, id, key);
      this.db
        .prepare(
          "UPDATE interactive_task_journal_v1 SET unfinished = 0 WHERE id = ? AND owner_key = ?",
        )
        .run(id, key);
      return this.unreadable(owner);
    });
  }

  /**
   * The owner accepts that the task's unresolved operation stays unknown, for
   * example after sign-out revoked the readback. The task is cancelled if it
   * was not, the operation keeps status "unknown" and nothing records success.
   * Only the slot is released, so a new task can start. It is refused while
   * the authorization is active: readback can still settle the outcome, and
   * a new task could repeat an effect that already happened. Revoke first.
   */
  acknowledgeUnknown(id: string, context: TaskContext): InteractiveTask {
    return this.transaction(() => {
      let task = this.get(id, context.owner);
      if (!task) fail("Task not found for this owner", "TASK_NOT_FOUND");
      if (task.revision !== context.expectedRevision)
        fail("Task revision changed", "TASK_CONFLICT");
      const operation = task.operations.find((op) => op.status === "unknown");
      if (!operation || this.acknowledged(id, operation.proposal.id))
        fail("No unknown operation to acknowledge", "TASK_REPLAY");
      if (task.authorization.state !== "revoked")
        fail("Readback can still resolve this outcome", "TASK_UNKNOWN_OUTCOME");
      if (!["completed", "cancelled"].includes(task.status)) {
        const result = transitionInteractiveTask(task, context, {
          type: "cancel",
        });
        task = result.task;
        this.db
          .prepare(
            "UPDATE interactive_task_journal_v1 SET document = ? WHERE id = ? AND owner_key = ?",
          )
          .run(JSON.stringify(task), id, ownerKey(context.owner));
        this.appendEvent(context.owner, result.event);
      }
      this.db
        .prepare(
          "INSERT INTO interactive_task_unknown_acknowledgements_v1 (task_id, owner_key, operation_id, acknowledged_at) VALUES (?, ?, ?, ?)",
        )
        .run(id, ownerKey(context.owner), operation.proposal.id, context.now);
      this.db
        .prepare(
          "UPDATE interactive_task_journal_v1 SET unfinished = 0 WHERE id = ? AND owner_key = ?",
        )
        .run(id, ownerKey(context.owner));
      return task;
    });
  }

  private acknowledged(id: string, operationId: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 AS acknowledged FROM interactive_task_unknown_acknowledgements_v1 WHERE task_id = ? AND operation_id = ?",
      )
      .get(id, operationId);
  }

  /** Call once after exclusive host startup, before accepting task commands.
   * A second live host must not call this as a replacement for coordination.
   * Even a prepared operation is cancelled; dispatched outcomes require readback.
   */
  recoverOwner(owner: TaskOwner, now: number): InteractiveTask | null {
    return this.transaction(() => {
      this.quarantineUnreadable(owner, now);
      const current = this.getUnfinished(owner);
      if (!current) return null;
      const { task, event } = transitionInteractiveTask(
        current,
        { owner, expectedRevision: current.revision, now },
        { type: "recover" },
      );
      this.db
        .prepare(
          "UPDATE interactive_task_journal_v1 SET document = ? WHERE id = ? AND owner_key = ?",
        )
        .run(JSON.stringify(task), task.id, ownerKey(owner));
      this.appendEvent(owner, event);
      return task;
    });
  }

  create(input: Parameters<typeof createInteractiveTask>[0]): InteractiveTask {
    const task = createInteractiveTask(input);
    return this.transaction(() => {
      const key = ownerKey(task.owner);
      const existing = this.db
        .prepare(
          "SELECT id FROM interactive_task_journal_v1 WHERE id = ? OR (owner_key = ? AND unfinished = 1)",
        )
        .get(task.id, key);
      if (
        existing &&
        this.db
          .prepare(
            "SELECT 1 AS held FROM interactive_task_journal_v1 AS tasks JOIN interactive_task_quarantine_v1 AS records ON records.task_id = tasks.id WHERE tasks.owner_key = ? AND tasks.unfinished = 1",
          )
          .get(key)
      )
        fail(
          "An unreadable unfinished task holds the slot until its owner acknowledges it",
          "TASK_UNREADABLE",
        );
      if (existing)
        fail(
          "An unfinished task or task identity already exists",
          "TASK_CONFLICT",
        );
      this.db
        .prepare(
          "INSERT INTO interactive_task_journal_v1 (id, owner_key, unfinished, document) VALUES (?, ?, 1, ?)",
        )
        .run(task.id, ownerKey(task.owner), JSON.stringify(task));
      this.appendEvent(task.owner, {
        schemaVersion: 1,
        eventId: `${task.id}#0`,
        taskId: task.id,
        sequence: 0,
        epoch: 0,
        kind: "create",
        at: task.updatedAt,
        status: task.status,
      });
      return task;
    });
  }

  transition(
    id: string,
    context: TaskContext,
    change: TaskTransition,
  ): ReturnType<typeof transitionInteractiveTask> {
    return this.transaction(() => {
      const current = this.get(id, context.owner);
      if (!current) fail("Task not found for this owner", "TASK_NOT_FOUND");
      const result = transitionInteractiveTask(current, context, change);
      // A cancelled task with an uncertain operation still occupies the slot.
      // Resolving that operation, or the owner acknowledging that its outcome
      // stays unknown, is mandatory before a replacement can start.
      const uncertain = result.task.operations.some(
        (operation) =>
          UNRESOLVED.includes(operation.status) &&
          !this.acknowledged(id, operation.proposal.id),
      );
      const unfinished =
        uncertain || !["completed", "cancelled"].includes(result.task.status);
      this.db
        .prepare(
          "UPDATE interactive_task_journal_v1 SET unfinished = ?, document = ? WHERE id = ? AND owner_key = ?",
        )
        .run(
          unfinished ? 1 : 0,
          JSON.stringify(result.task),
          id,
          ownerKey(context.owner),
        );
      this.appendEvent(context.owner, result.event);
      return result;
    });
  }
}
