/** Durable current task presentation. Hosts own delivery, styling and effect dispatch. */
import {
  ElizaError,
  type TaskChoiceWidget,
  validateTaskChoiceWidget,
} from "@elizaos/core/protocol";
import type { InteractiveTaskChoices } from "./interactive-task-choices.ts";
import type { InteractiveTaskRuntime } from "./interactive-task-runtime.ts";
import type { TaskSqliteConnection } from "./interactive-task-store.ts";

export class SqliteTaskPresentation {
  private readonly ownerKey: string;
  constructor(
    private readonly db: TaskSqliteConnection,
    private readonly runtime: InteractiveTaskRuntime,
    private readonly choices: InteractiveTaskChoices,
  ) {
    const mode = db.prepare("PRAGMA synchronous").get() as
      | { synchronous?: number }
      | undefined;
    if (!mode || ![2, 3].includes(Number(mode.synchronous)))
      throw new ElizaError("Task presentation requires durable storage", {
        code: "TASK_PRESENTATION_NOT_DURABLE",
      });
    const owner = runtime.owner;
    this.ownerKey = JSON.stringify([
      owner.agentId,
      owner.actorId,
      owner.connector.source,
      owner.connector.accountId,
    ]);
    db.exec(`CREATE TABLE IF NOT EXISTS interactive_task_presentation_v1 (
      owner_key TEXT NOT NULL, task_id TEXT NOT NULL, generation INTEGER NOT NULL, document TEXT,
      PRIMARY KEY(owner_key,task_id))`);
  }
  private reserve(taskId: string): number {
    this.runtime.get(taskId);
    const row = this.db
      .prepare(`INSERT INTO interactive_task_presentation_v1(owner_key,task_id,generation,document) VALUES(?,?,1,NULL)
      ON CONFLICT(owner_key,task_id) DO UPDATE SET generation=generation+1, document=NULL
      WHERE generation < 9007199254740991 RETURNING generation`)
      .get(this.ownerKey, taskId) as { generation?: number } | undefined;
    const generation = row?.generation;
    if (typeof generation !== "number" || !Number.isSafeInteger(generation))
      throw new ElizaError("Task presentation revision exhausted", {
        code: "TASK_PRESENTATION_REVISION_EXHAUSTED",
      });
    return generation;
  }
  /** Called only by an authenticated host workflow, never by model or renderer input. */
  async publish(
    taskId: string,
    contextKey: string,
    block: TaskChoiceWidget["block"],
  ): Promise<TaskChoiceWidget> {
    const generation = this.reserve(taskId);
    const widget = await this.choices.offer(taskId, contextKey, block);
    const current = await this.choices.refresh(widget);
    const task = this.runtime.get(taskId);
    if (
      task.epoch !== current.epoch ||
      task.status !== "active" ||
      task.authorization.state !== "active"
    )
      throw new ElizaError("Task presentation is no longer current", {
        code: "TASK_CHOICE_STALE",
      });
    this.db
      .prepare(
        "UPDATE interactive_task_presentation_v1 SET document=? WHERE owner_key=? AND task_id=? AND generation=?",
      )
      .run(JSON.stringify(current), this.ownerKey, taskId, generation);
    const latest = this.db
      .prepare(
        "SELECT generation FROM interactive_task_presentation_v1 WHERE owner_key=? AND task_id=?",
      )
      .get(this.ownerKey, taskId) as { generation: number };
    if (latest.generation !== generation)
      throw new ElizaError("Task presentation was superseded", {
        code: "TASK_CHOICE_STALE",
      });
    return current;
  }
  /** No new offer, observation, model call or task effect occurs on read. */
  async read(taskId: string): Promise<TaskChoiceWidget | null> {
    const task = this.runtime.get(taskId);
    if (task.status !== "active" || task.authorization.state !== "active")
      return null;
    const row = this.db
      .prepare(
        "SELECT document FROM interactive_task_presentation_v1 WHERE owner_key=? AND task_id=?",
      )
      .get(this.ownerKey, taskId) as { document?: unknown } | undefined;
    if (!row || row.document === null) return null;
    if (typeof row.document !== "string" || row.document.length > 100000)
      throw new ElizaError("Invalid task presentation storage", {
        code: "TASK_PRESENTATION_CORRUPT",
      });
    let value: unknown;
    try {
      value = JSON.parse(row.document);
    } catch (cause) {
      throw new ElizaError("Invalid task presentation storage", {
        code: "TASK_PRESENTATION_CORRUPT",
        cause,
      });
    }
    validateTaskChoiceWidget(value);
    if (value.taskId !== taskId)
      throw new ElizaError("Invalid task presentation binding", {
        code: "TASK_PRESENTATION_CORRUPT",
      });
    try {
      const current = await this.choices.refresh(value);
      const latest = this.db
        .prepare(
          "SELECT document FROM interactive_task_presentation_v1 WHERE owner_key=? AND task_id=?",
        )
        .get(this.ownerKey, taskId) as { document: unknown } | undefined;
      const task = this.runtime.get(taskId);
      if (
        task.epoch !== current.epoch ||
        task.status !== "active" ||
        task.authorization.state !== "active"
      )
        return null;
      return latest?.document === row.document ? current : null;
    } catch (error) {
      // error-policy:J4 Pause, expiry and ownership changes remove an obsolete presentation.
      if (error instanceof ElizaError && error.code === "TASK_CHOICE_STALE")
        return null;
      throw error;
    }
  }
  /** Removes presentation only; task cancellation remains an explicit runtime operation. */
  clear(taskId: string): void {
    this.reserve(taskId);
  }
}
