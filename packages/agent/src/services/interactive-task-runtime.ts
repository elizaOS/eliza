/** Host coordinator for a single authenticated owner's interactive task.
 * The actuator must independently validate page/frame/input revision and policy
 * at the instant of the effect. No renderer may call execute or supply observations.
 */
import { ElizaError } from "@elizaos/core/errors";
import type {
  InteractiveTask,
  TaskActionProposal,
  TaskObservation,
  TaskOwner,
} from "@elizaos/core/messaging/interactive-task";
import type { SqliteInteractiveTaskStore } from "./interactive-task-store.ts";

export interface InteractiveTaskActuator {
  readonly capabilities: readonly string[];
  /** Remove host-owned transient UI/effects; resolves only after acknowledgement. */
  quiesce?(context: { owner: TaskOwner; taskId: string }): Promise<void>;
  observe(context: {
    owner: TaskOwner;
    taskId: string;
    signal: AbortSignal;
  }): Promise<TaskObservation>;
  execute(
    proposal: TaskActionProposal,
    context: {
      owner: TaskOwner;
      signal: AbortSignal;
      /** Required immediately before the native effect, in addition to native checks. */
      isCurrent: () => boolean;
    },
  ): Promise<{
    status: "succeeded" | "failed" | "unknown";
    evidenceRef?: string;
  }>;
}
export type AuthorizedTaskGoal = Pick<
  Parameters<SqliteInteractiveTaskStore["create"]>[0],
  "id" | "goalRef" | "authorization" | "allowedCapabilities" | "allowedOrigins"
>;

export class InteractiveTaskRuntime {
  private readonly pending = new Map<string, AbortController>();
  private poisoned = false;
  private cleanup = new Map<
    string,
    { promise: Promise<void>; failed: boolean }
  >();
  readonly owner: TaskOwner;
  constructor(
    private readonly options: {
      owner: TaskOwner;
      store: SqliteInteractiveTaskStore;
      actuator: InteractiveTaskActuator;
      now?: () => number;
    },
  ) {
    this.owner = Object.freeze({
      ...options.owner,
      connector: Object.freeze({ ...options.owner.connector }),
    });
    // Host starts this instance before accepting task requests. This also fences
    // any surviving previous instance via the persisted revision/epoch.
    options.store.recoverOwner(this.owner, this.now());
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private requireHealthy(): void {
    if (this.poisoned)
      throw new ElizaError("Task runtime requires storage recovery", {
        code: "TASK_STORAGE_UNCERTAIN",
      });
  }
  get(id: string): InteractiveTask {
    this.requireHealthy();
    const task = this.options.store.get(id, this.owner);
    if (!task)
      throw new ElizaError("Task not found", { code: "TASK_NOT_FOUND" });
    return task;
  }
  current(): InteractiveTask | null {
    this.requireHealthy();
    return this.options.store.getUnfinished(this.owner);
  }
  events(id: string, afterSequence = -1) {
    this.requireHealthy();
    return this.options.store.events(id, this.owner, afterSequence);
  }
  create(goal: AuthorizedTaskGoal): InteractiveTask {
    this.requireHealthy();
    // Policy and actual actuator capabilities both constrain this task. Missing
    // capabilities are unavailable; never substitute a generic JS executor.
    const allowedCapabilities = goal.allowedCapabilities.filter((capability) =>
      this.options.actuator.capabilities.includes(capability),
    );
    return this.options.store.create({
      ...goal,
      allowedCapabilities,
      owner: this.owner,
      now: this.now(),
    });
  }
  private startCleanup(id: string) {
    const quiesce = this.options.actuator.quiesce;
    if (!quiesce) return;
    const entry = { failed: false, promise: Promise.resolve() };
    entry.promise = Promise.resolve().then(() =>
      quiesce.call(this.options.actuator, { owner: this.owner, taskId: id }),
    );
    this.cleanup.set(id, entry);
    // Observe rejection now; settle() still reports it to the requesting host.
    void entry.promise.catch(() => {
      entry.failed = true;
    });
    return entry;
  }
  /** Retry only host cleanup, never an action or task transition. */
  async settle(id?: string): Promise<void> {
    for (const taskId of id ? [id] : [...this.cleanup.keys()]) {
      for (;;) {
        let entry = this.cleanup.get(taskId);
        if (!entry) break;
        if (entry.failed) entry = this.startCleanup(taskId) ?? entry;
        try {
          await entry.promise;
        } catch {
          if (this.cleanup.get(taskId) !== entry) continue;
          throw new ElizaError(
            "Task stopped, but host cleanup was not confirmed",
            { code: "TASK_CLEANUP_UNCONFIRMED" },
          );
        }
        if (this.cleanup.get(taskId) === entry) this.cleanup.delete(taskId);
      }
    }
  }
  control(
    id: string,
    expectedRevision: number,
    type: "pause" | "cancel" | "revoke",
  ): InteractiveTask {
    this.requireHealthy();
    let shouldAbort = false;
    try {
      const result = this.options.store.transition(
        id,
        { owner: this.owner, expectedRevision, now: this.now() },
        { type },
      ).task;
      shouldAbort = true;
      return result;
    } catch (error) {
      // A storage failure must stop effects even when the durable epoch could
      // not be advanced. A normal stale request does not poison healthy storage.
      if (
        !(error instanceof ElizaError) ||
        error.code.startsWith("TASK_STORAGE")
      ) {
        this.poisoned = true;
        shouldAbort = true;
      }
      throw error;
    } finally {
      if (shouldAbort) {
        this.pending.get(id)?.abort();
        this.startCleanup(id);
      }
    }
  }
  private begin(id: string): AbortController {
    this.requireHealthy();
    if (this.pending.has(id))
      throw new ElizaError("Task operation is already running", {
        code: "TASK_BUSY",
      });
    const controller = new AbortController();
    this.pending.set(id, controller);
    return controller;
  }
  async observe(
    id: string,
    expectedRevision: number,
    resume = false,
    stillAuthorized?: () => Promise<boolean>,
  ): Promise<InteractiveTask> {
    await this.settle(id);
    const before = this.get(id);
    if (before.revision !== expectedRevision)
      throw new ElizaError("Task revision changed", { code: "TASK_CONFLICT" });
    if (
      before.authorization.state !== "active" ||
      before.status !== (resume ? "paused" : "active")
    )
      throw new ElizaError("Task is not authorized to observe", {
        code: "TASK_NOT_ACTIVE",
      });
    if (
      before.operations.some((operation) =>
        ["dispatched", "unknown"].includes(operation.status),
      )
    )
      throw new ElizaError("Resolve the previous operation first", {
        code: "TASK_UNKNOWN_OUTCOME",
      });
    const controller = this.begin(id);
    try {
      const observation = await this.options.actuator.observe({
        owner: this.owner,
        taskId: id,
        signal: controller.signal,
      });
      if (stillAuthorized && !(await stillAuthorized()))
        throw new ElizaError("Task authorization changed", {
          code: "TASK_REVOKED",
        });
      controller.signal.throwIfAborted();
      this.requireHealthy();
      return this.options.store.transition(
        id,
        { owner: this.owner, expectedRevision, now: this.now() },
        { type: resume ? "resume" : "observe", observation },
      ).task;
    } finally {
      this.pending.delete(id);
    }
  }
  /** Trusted planner entrypoint; deliberately absent from the renderer routes. */
  async execute(
    id: string,
    expectedRevision: number,
    proposal: TaskActionProposal,
  ): Promise<InteractiveTask> {
    if (!this.options.actuator.capabilities.includes(proposal.capability))
      throw new ElizaError("Actuator capability is unavailable", {
        code: "TASK_ACTION_DENIED",
      });
    const controller = this.begin(id);
    try {
      const prepared = this.options.store.transition(
        id,
        { owner: this.owner, expectedRevision, now: this.now() },
        { type: "prepare", proposal },
      ).task;
      const dispatched = this.options.store.transition(
        id,
        {
          owner: this.owner,
          expectedRevision: prepared.revision,
          now: this.now(),
        },
        { type: "dispatch", operationId: proposal.id },
      ).task;
      const isCurrent = () => {
        if (
          controller.signal.aborted ||
          this.poisoned ||
          !this.options.actuator.capabilities.includes(proposal.capability)
        )
          return false;
        const current = this.get(id);
        return (
          current.revision === dispatched.revision &&
          current.epoch === dispatched.epoch &&
          current.status === "waiting" &&
          current.authorization.state === "active"
        );
      };
      let outcome: Awaited<ReturnType<InteractiveTaskActuator["execute"]>>;
      try {
        // The durable dispatched record exists before the adapter is entered.
        outcome = await this.options.actuator.execute(
          structuredClone(proposal),
          { owner: this.owner, signal: controller.signal, isCurrent },
        );
      } catch {
        // Lost/error replies are not proof that an effect failed to occur.
        outcome = { status: "unknown" };
      }
      if (!isCurrent()) return this.get(id);
      return this.options.store.transition(
        id,
        {
          owner: this.owner,
          expectedRevision: dispatched.revision,
          now: this.now(),
        },
        { type: "result", operationId: proposal.id, ...outcome },
      ).task;
    } finally {
      this.pending.delete(id);
    }
  }
}
