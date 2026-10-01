/** Durable task journal on a host-supplied SQLite connection.
 * The host owns database location, encryption, migrations and authenticated owner
 * resolution. No raw page text, credentials or secret values belong in this store.
 * Each method is synchronous: an effect may start only after transition returns.
 */

import { ElizaError } from "@elizaos/core/errors";
import {
  createInteractiveTask,
  type InteractiveTask,
  sameTaskOwner,
  type TaskContext,
  type TaskEvent,
  type TaskOwner,
  type TaskTransition,
  transitionInteractiveTask,
  validateInteractiveTask,
  validateTaskEvent,
} from "@elizaos/core/messaging/interactive-task";

export interface TaskSqliteConnection {
  exec(sql: string): unknown;
  prepare(sql: string): {
    get(...parameters: (string | number)[]): unknown;
    run(...parameters: (string | number)[]): unknown;
  };
}

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
function decode(row: unknown): InteractiveTask | null {
  if (row === undefined || row === null) return null;
  if (
    typeof row !== "object" ||
    !("document" in row) ||
    typeof row.document !== "string"
  )
    fail("Invalid persisted task row", "TASK_STORAGE_CORRUPT");
  let value: InteractiveTask;
  try {
    value = JSON.parse(row.document) as InteractiveTask;
  } catch {
    fail("Invalid persisted task JSON", "TASK_STORAGE_CORRUPT");
  }
  validateInteractiveTask(value);
  return value;
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
      };
    });
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
    const task = decode(
      this.db
        .prepare(
          "SELECT document FROM interactive_task_journal_v1 WHERE id = ? AND owner_key = ?",
        )
        .get(id, ownerKey(owner)),
    );
    if (task && (task.id !== id || !sameTaskOwner(task.owner, owner)))
      fail("Task row identity mismatch", "TASK_STORAGE_CORRUPT");
    return task;
  }

  getUnfinished(owner: TaskOwner): InteractiveTask | null {
    const task = decode(
      this.db
        .prepare(
          "SELECT document FROM interactive_task_journal_v1 WHERE owner_key = ? AND unfinished = 1",
        )
        .get(ownerKey(owner)),
    );
    if (task && !sameTaskOwner(task.owner, owner))
      fail("Task row identity mismatch", "TASK_STORAGE_CORRUPT");
    return task;
  }

  /** Call once after exclusive host startup, before accepting task commands.
   * A second live host must not call this as a replacement for coordination.
   * Even a prepared operation is cancelled; dispatched outcomes require readback.
   */
  recoverOwner(owner: TaskOwner, now: number): InteractiveTask | null {
    return this.transaction(() => {
      const current = decode(
        this.db
          .prepare(
            "SELECT document FROM interactive_task_journal_v1 WHERE owner_key = ? AND unfinished = 1",
          )
          .get(ownerKey(owner)),
      );
      if (!current) return null;
      if (!sameTaskOwner(current.owner, owner))
        fail("Task row identity mismatch", "TASK_STORAGE_CORRUPT");
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
      const existing = this.db
        .prepare(
          "SELECT id FROM interactive_task_journal_v1 WHERE id = ? OR (owner_key = ? AND unfinished = 1)",
        )
        .get(task.id, ownerKey(task.owner));
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
      // Resolving that operation is mandatory before a replacement can start.
      const uncertain = result.task.operations.some((operation) =>
        ["prepared", "dispatched", "unknown"].includes(operation.status),
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
