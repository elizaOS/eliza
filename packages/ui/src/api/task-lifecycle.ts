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

/** Pause and Close give up after this long and report the failure. */
export const TASK_PAUSE_TIMEOUT_MS = 10_000;
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Task request timed out")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

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
    if (this.state.pending || this.starting) return;
    const ticket = ++this.generation;
    try {
      const task = taskFrom(await this.request("/tasks/current"));
      if (ticket === this.generation) this.publish({ ...this.state, task });
    } catch {
      /* A disconnected runtime is reported by its connection controls. */
    }
  }
  /**
   * One request: the host pauses its current task when the request arrives.
   * It does not wait for a pending start; a task that start creates later is
   * paused as soon as its reply arrives.
   */
  private async pauseCurrent(
    command: "pause" | "close",
    ticket: number,
  ): Promise<boolean> {
    const pause = () =>
      withTimeout(
        this.request(
          "/tasks/current/pause",
          command === "close" ? { reason: "close" } : {},
        ),
        TASK_PAUSE_TIMEOUT_MS,
      ).then((reply) => {
        const task = taskFrom(reply);
        if (task && !["paused", "completed", "cancelled"].includes(task.status))
          throw new Error("Invalid task transition");
        return task;
      });
    const starting = this.starting;
    try {
      const task = await pause();
      if (ticket !== this.generation) return false;
      this.publish({ task, pending: false, error: "" });
      return true;
    } finally {
      if (starting) {
        // Report the current pause immediately. Retain the owner's pause intent
        // separately until a pending creation settles, even if its reply is lost.
        void (async () => {
          try {
            await starting;
          } catch {
            // A missing reply cannot prove that creation had no effect.
          }
          if (ticket !== this.generation) return;
          const task = await pause();
          if (ticket === this.generation)
            this.publish({ task, pending: false, error: "" });
        })().catch(() => {
          if (ticket === this.generation)
            this.publish({
              ...this.state,
              pending: false,
              error: this.messages.pause,
            });
        });
      }
    }
  }

  async control(command: TaskLifecycleCommand): Promise<boolean> {
    if (this.state.pending && command === "resume") return false;
    this.lastCommand = command;
    const ticket = ++this.generation;
    this.publish({ ...this.state, pending: true, error: "" });
    if (command === "pause" || command === "close")
      return this.pauseCurrent(command, ticket).catch(() => {
        if (ticket === this.generation)
          this.publish({
            ...this.state,
            pending: false,
            error: this.messages.pause,
          });
        return false;
      });
    try {
      // Cancel must also cover a create request whose response has not arrived.
      if (this.starting) {
        try {
          await this.starting;
        } catch {
          /* Reconcile current task after an uncertain create. */
        }
      }
      if (ticket !== this.generation) return false;
      const task = taskFrom(await this.request("/tasks/current"));
      if (ticket !== this.generation) return false;
      if (!task) {
        this.publish({ task: null, pending: false, error: "" });
        return true;
      }
      const result = taskFrom(
        await this.request(`/tasks/${encodeURIComponent(task.id)}/${command}`, {
          expectedRevision: task.revision,
        }),
      );
      if (ticket !== this.generation) return false;
      if (
        !result ||
        result.id !== task.id ||
        result.revision <= task.revision ||
        result.epoch < task.epoch ||
        (command === "cancel" && result.epoch <= task.epoch) ||
        result.status !== { resume: "active", cancel: "cancelled" }[command]
      )
        throw new Error("Invalid task transition");
      this.publish({ task: result, pending: false, error: "" });
      return true;
    } catch {
      if (ticket === this.generation)
        this.publish({
          ...this.state,
          pending: false,
          error: this.messages[command],
        });
      return false;
    }
  }
}
