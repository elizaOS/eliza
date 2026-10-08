export type TaskView = {
  schemaVersion: 1;
  id: string;
  revision: number;
  epoch: number;
  status:
    | "active"
    | "paused"
    | "blocked"
    | "waiting"
    | "completed"
    | "cancelled";
  hasUnknownOutcome: boolean;
};
export type TaskLifecycleState = {
  task: TaskView | null;
  pending: boolean;
  error: string;
};
export type TaskLifecycleRequest = (
  path: string,
  body?: unknown,
) => Promise<unknown>;

export type TaskLifecycleMessages = Readonly<
  Record<"start" | "pause" | "resume" | "cancel", string>
>;

function taskFrom(value: unknown): TaskView | null {
  if (!value || typeof value !== "object" || !("task" in value))
    throw new Error("Invalid task reply");
  const task = value.task;
  if (task === null) return null;
  if (!task || typeof task !== "object") throw new Error("Invalid task reply");
  const t = task as TaskView;
  if (
    t.schemaVersion !== 1 ||
    typeof t.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/.test(t.id) ||
    !Number.isSafeInteger(t.revision) ||
    t.revision < 0 ||
    !Number.isSafeInteger(t.epoch) ||
    t.epoch < 0 ||
    ![
      "active",
      "paused",
      "blocked",
      "waiting",
      "completed",
      "cancelled",
    ].includes(t.status) ||
    typeof t.hasUnknownOutcome !== "boolean"
  )
    throw new Error("Invalid task reply");
  return {
    schemaVersion: 1,
    id: t.id,
    revision: t.revision,
    epoch: t.epoch,
    status: t.status,
    hasUnknownOutcome: t.hasUnknownOutcome,
  };
}

/** "close" pauses the task and tells the host that the user closed its surface. */
export type TaskLifecycleCommand = "pause" | "close" | "resume" | "cancel";

/** Renderer state is a projection, never a task authorization or checkpoint. */
export class TaskLifecycle {
  private generation = 0;
  private starting: Promise<TaskView | null> | null = null;
  private lastCommand: TaskLifecycleCommand = "pause";
  private state: TaskLifecycleState = { task: null, pending: false, error: "" };
  private readonly messages: TaskLifecycleMessages;
  private request: TaskLifecycleRequest;
  private changed: (state: TaskLifecycleState) => void;
  constructor(
    request: TaskLifecycleRequest,
    changed: (state: TaskLifecycleState) => void,
    messages: TaskLifecycleMessages,
  ) {
    this.request = request;
    this.changed = changed;
    this.messages = { ...messages };
  }
  private publish(next: TaskLifecycleState) {
    this.state = next;
    this.changed(next);
  }
  reset() {
    this.generation++;
    this.starting = null;
    this.publish({ task: null, pending: false, error: "" });
  }
  retry() {
    return this.control(this.lastCommand);
  }
  interruptStart() {
    if (this.starting) void this.control("pause");
  }
  async start(goalRef: string): Promise<boolean> {
    if (this.starting || this.state.pending) return false;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(goalRef)) return false;
    const ticket = ++this.generation;
    this.publish({ ...this.state, pending: true, error: "" });
    const creation = (async () => {
      const current = taskFrom(await this.request("/tasks/current"));
      if (ticket !== this.generation) return current;
      return current || taskFrom(await this.request("/tasks", { goalRef }));
    })();
    this.starting = creation;
    try {
      const task = await creation;
      if (ticket !== this.generation) return false;
      if (!task) throw new Error("No task returned");
      this.publish({ task, pending: false, error: "" });
      return true;
    } catch {
      if (ticket === this.generation)
        this.publish({
          ...this.state,
          pending: false,
          error: this.messages.start,
        });
      return false;
    } finally {
      if (this.starting === creation) this.starting = null;
    }
  }

  async refresh() {
    // A background read must never supersede a user control.
    if (this.state.pending) return;
    const ticket = ++this.generation;
    try {
      const task = taskFrom(await this.request("/tasks/current"));
      if (ticket === this.generation) this.publish({ ...this.state, task });
    } catch {
      /* A disconnected runtime is reported by its connection controls. */
    }
  }
  async control(command: TaskLifecycleCommand): Promise<boolean> {
    if (this.state.pending && command === "resume") return false;
    this.lastCommand = command;
    const ticket = ++this.generation;
    this.publish({ ...this.state, pending: true, error: "" });
    try {
      // Close must also cover a create request whose response has not arrived.
      if (this.starting) {
        try {
          await this.starting;
        } catch {
          /* Reconcile current task after an uncertain create. */
        }
      }
      if (ticket !== this.generation) return false;
      // Read authoritative revision, including when Close precedes startup read.
      const task = taskFrom(await this.request("/tasks/current"));
      if (ticket !== this.generation) return false;
      if (!task) {
        this.publish({ task: null, pending: false, error: "" });
        return true;
      }
      // Close still reaches a paused task, so the host can remove its paused guide.
      if (
        (command === "pause" && task.status === "paused") ||
        ((command === "pause" || command === "close") &&
          ["completed", "cancelled"].includes(task.status))
      ) {
        this.publish({ task, pending: false, error: "" });
        return true;
      }
      const result = taskFrom(
        await this.request(
          `/tasks/${encodeURIComponent(task.id)}/${command === "close" ? "pause" : command}`,
          command === "close"
            ? { expectedRevision: task.revision, reason: "close" }
            : { expectedRevision: task.revision },
        ),
      );
      if (ticket !== this.generation) return false;
      if (
        !result ||
        result.id !== task.id ||
        result.revision <= task.revision ||
        result.epoch < task.epoch ||
        (command !== "resume" && result.epoch <= task.epoch) ||
        result.status !==
          {
            pause: "paused",
            close: "paused",
            resume: "active",
            cancel: "cancelled",
          }[command]
      )
        throw new Error("Invalid task transition");
      this.publish({ task: result, pending: false, error: "" });
      return true;
    } catch {
      if (ticket === this.generation)
        this.publish({
          ...this.state,
          pending: false,
          error: this.messages[command === "close" ? "pause" : command],
        });
      return false;
    }
  }
}
