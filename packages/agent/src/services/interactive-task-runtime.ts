/** Host coordinator for a single authenticated owner's interactive task.
 * The actuator must independently validate page/frame/input revision and policy
 * at the instant of the effect. No renderer may call execute or supply observations.
 */
import {
  ElizaError,
  type InteractiveTask,
  TASK_ACTION_NOT_DISPATCHED,
  TASK_ACTION_NOT_DISPATCHED_REF,
  type TaskActionProposal,
  type TaskObservation,
  type TaskOwner,
  type TaskTransition,
  transitionInteractiveTask,
} from "@elizaos/core/protocol";
import type { SqliteInteractiveTaskStore } from "./interactive-task-store.ts";

/**
 * Why host cleanup runs after a task control. "close" is a pause whose user
 * also closed the task surface. Actuator-internal cleanup passes no reason.
 */
export type TaskCleanupReason =
  | "pause"
  | "close"
  | "cancel"
  | "revoke"
  | "complete";

export interface InteractiveTaskActuator {
  readonly capabilities: readonly string[];
  /** Remove host-owned transient UI/effects; resolves only after acknowledgement. */
  quiesce?(context: {
    owner: TaskOwner;
    taskId: string;
    reason?: TaskCleanupReason;
  }): Promise<void>;
  observe(context: {
    owner: TaskOwner;
    taskId: string;
    signal: AbortSignal;
  }): Promise<TaskObservation>;
  /**
   * The task's origin scope changed (a host extension or retraction, already
   * persisted under a new epoch). Drop page state from the old scope and apply
   * `allowedOrigins` to the page's navigation policy; resolve only once applied.
   */
  scopeChanged?(context: {
    owner: TaskOwner;
    taskId: string;
    epoch: number;
    allowedOrigins: readonly string[];
  }): Promise<void>;
  /** Trusted readback only; must never repeat the effect or accept client receipts. */
  reconcile?(
    proposal: TaskActionProposal,
    context: {
      owner: TaskOwner;
      signal: AbortSignal;
      isCurrent: () => boolean;
    },
  ): Promise<
    | { status: "succeeded" | "failed"; evidenceRef: string }
    | { status: "unknown"; evidenceRef?: string }
  >;
  execute(
    proposal: TaskActionProposal,
    context: {
      owner: TaskOwner;
      signal: AbortSignal;
      /** Required immediately before the native effect, in addition to native checks. */
      isCurrent: () => boolean;
    },
  ): Promise<
    | { status: "succeeded" | "failed"; evidenceRef: string }
    | { status: "unknown"; evidenceRef?: string }
  >;
}
export type AuthorizedTaskGoal = Pick<
  Parameters<SqliteInteractiveTaskStore["create"]>[0],
  "id" | "goalRef" | "authorization" | "allowedCapabilities" | "allowedOrigins"
>;

export class InteractiveTaskRuntime {
  private readonly pending = new Map<string, AbortController>();
  /** One scope apply per task at a time; each applies the latest persisted scope. */
  private readonly scopeApplies = new Map<string, Promise<void>>();
  private poisoned = false;
  private cleanup = new Map<
    string,
    { promise: Promise<void>; failed: boolean; reason?: TaskCleanupReason }
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
  private startCleanup(id: string, reason?: TaskCleanupReason) {
    const quiesce = this.options.actuator.quiesce;
    if (!quiesce) return;
    const previous = this.cleanup.get(id);
    const entry = { failed: false, promise: Promise.resolve(), reason };
    // Finish the older cleanup before a newer reason changes host presentation.
    // Only the new acknowledgement can supersede an earlier cleanup failure.
    entry.promise = (previous?.promise ?? Promise.resolve())
      .catch(() => undefined)
      .then(() =>
        quiesce.call(this.options.actuator, {
          owner: this.owner,
          taskId: id,
          ...(reason ? { reason } : {}),
        }),
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
        if (entry.failed)
          entry = this.startCleanup(taskId, entry.reason) ?? entry;
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
  /** "close" is the "pause" transition; only the cleanup reason differs. */
  control(
    id: string,
    expectedRevision: number,
    type: Exclude<TaskCleanupReason, "complete">,
  ): InteractiveTask {
    return this.applyControl(id, expectedRevision, type);
  }
  private applyControl(
    id: string,
    expectedRevision: number,
    type: TaskCleanupReason,
  ): InteractiveTask {
    return this.fence(
      id,
      expectedRevision,
      { type: type === "close" ? "pause" : type },
      type,
    );
  }
  /** A transition that ends in-flight work: abort it and clean up even on storage failure. */
  private fence(
    id: string,
    expectedRevision: number,
    transition: TaskTransition,
    reason?: TaskCleanupReason,
  ): InteractiveTask {
    this.requireHealthy();
    let shouldAbort = false;
    try {
      const result = this.options.store.transition(
        id,
        { owner: this.owner, expectedRevision, now: this.now() },
        transition,
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
        this.startCleanup(id, reason);
      }
    }
  }
  private applyScope(id: string): Promise<void> {
    const scopeChanged = this.options.actuator.scopeChanged;
    if (!scopeChanged) return Promise.resolve();
    // Scope changes can commit while an earlier apply is still awaiting the
    // page. Applies run one at a time and each reads the persisted scope when
    // it starts, so an older origin list can never be written last.
    const run = (this.scopeApplies.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const task = this.get(id);
        try {
          await scopeChanged.call(this.options.actuator, {
            owner: this.owner,
            taskId: task.id,
            epoch: task.epoch,
            allowedOrigins: Object.freeze([...task.allowedOrigins]),
          });
        } catch (cause) {
          throw new ElizaError(
            "Task scope changed, but the page policy was not confirmed",
            { code: "TASK_SCOPE_UNCONFIRMED", cause },
          );
        }
      });
    this.scopeApplies.set(id, run);
    run
      .finally(() => {
        if (this.scopeApplies.get(id) === run) this.scopeApplies.delete(id);
      })
      .catch(() => undefined);
    return run;
  }
  /**
   * Trusted host only, never a renderer route: extend a running task to one
   * more exact HTTPS origin, for example the sign-in service a site hands the
   * person to. `checkOrigin` is the host's own safety check (blocklist,
   * look-alike) for that origin; it returns an opaque reference to the passed
   * check, or null to refuse. Never call this for a page the task merely
   * reached: every extension is an explicit host decision, audited per origin.
   */
  async extendOrigin(
    id: string,
    expectedRevision: number,
    origin: string,
    checkOrigin: (origin: string) => Promise<string | null>,
  ): Promise<InteractiveTask> {
    await this.settle(id);
    const before = this.get(id);
    if (before.revision !== expectedRevision)
      throw new ElizaError("Task revision changed", { code: "TASK_CONFLICT" });
    if (
      before.authorization.state !== "active" ||
      !["active", "paused"].includes(before.status)
    )
      throw new ElizaError("Task scope cannot change now", {
        code: "TASK_NOT_ACTIVE",
      });
    const controller = this.begin(id);
    let task: InteractiveTask;
    try {
      const checkRef = await checkOrigin(origin);
      if (checkRef === null)
        throw new ElizaError("The host did not allow this website", {
          code: "TASK_ORIGIN_REFUSED",
        });
      controller.signal.throwIfAborted();
      task = this.options.store.transition(
        id,
        { owner: this.owner, expectedRevision, now: this.now() },
        { type: "extend-origin", origin, checkRef },
      ).task;
    } finally {
      this.pending.delete(id);
    }
    await this.applyScope(id);
    return task;
  }
  /**
   * Remove an origin `extendOrigin` added; the starting origins stay. Like
   * pause, it fences in-flight work: an action that was dispatched becomes an
   * unknown outcome and the task pauses. It works after the task ended too.
   */
  async retractOrigin(
    id: string,
    expectedRevision: number,
    origin: string,
  ): Promise<InteractiveTask> {
    const task = this.fence(id, expectedRevision, {
      type: "retract-origin",
      origin,
    });
    // The fence's cleanup hides guidance; let it finish before the scope change
    // quiesces again, so the two never race on the same guidance revision.
    // The narrower scope is applied to the page even if that cleanup failed.
    let cleanupError: unknown;
    try {
      await this.settle(id);
    } catch (error) {
      cleanupError = error;
    }
    await this.applyScope(id);
    if (cleanupError !== undefined) throw cleanupError;
    return task;
  }
  /** Re-apply the persisted origin scope, for example after a host restart. */
  async syncScope(id: string): Promise<InteractiveTask> {
    await this.applyScope(id);
    return this.get(id);
  }
  /** Trusted host only: verify and save the requested result before calling this.
   * Completion records task state, not proof that the goal was achieved. The
   * renderer cannot supply a result or invoke this through the HTTP handler.
   */
  async complete(
    id: string,
    expectedRevision: number,
    stillAuthorized: () => Promise<boolean>,
  ): Promise<InteractiveTask> {
    this.requireHealthy();
    const task = this.get(id);
    if (task.status !== "active" || task.revision !== expectedRevision)
      throw new ElizaError("Task is no longer active at this revision", {
        code: "TASK_CONFLICT",
      });
    if (!(await stillAuthorized()))
      throw new ElizaError("Task authorization changed", {
        code: "TASK_UNAUTHORIZED",
      });
    const result = this.applyControl(id, expectedRevision, "complete");
    await this.settle(id);
    return result;
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
  /** Trusted host readback; resolving an operation never resumes the task. */
  async reconcile(
    id: string,
    expectedRevision: number,
    operationId: string,
    stillAuthorized: () => Promise<boolean>,
  ): Promise<InteractiveTask> {
    await this.settle(id);
    const before = this.get(id);
    if (before.revision !== expectedRevision)
      throw new ElizaError("Task revision changed", { code: "TASK_CONFLICT" });
    if (
      before.authorization.state !== "active" ||
      !["paused", "blocked", "cancelled"].includes(before.status)
    )
      throw new ElizaError("Task is not authorized for readback", {
        code: "TASK_NOT_ACTIVE",
      });
    const operation = before.operations.find(
      (op) => op.proposal.id === operationId,
    );
    if (operation?.status !== "unknown")
      throw new ElizaError("No unknown operation to reconcile", {
        code: "TASK_REPLAY",
      });
    const readback = this.options.actuator.reconcile;
    if (!readback)
      throw new ElizaError("Readback is unavailable", {
        code: "TASK_UNAVAILABLE",
      });
    const controller = this.begin(id);
    let fence = before;
    const isCurrent = () => {
      if (controller.signal.aborted || this.poisoned) return false;
      const current = this.get(id);
      return (
        current.revision === fence.revision &&
        current.epoch === fence.epoch &&
        current.authorization.state === "active" &&
        current.status === fence.status
      );
    };
    try {
      if (!(await stillAuthorized()) || !isCurrent())
        throw new ElizaError("Task authorization changed", {
          code: "TASK_REVOKED",
        });
      // Each explicit readback consumes a native binding, even if its result is
      // unknown or its reply is lost. Persist a new recovery epoch first so a
      // later check never has to reuse or widen the previous native authority.
      fence = this.options.store.transition(
        id,
        { owner: this.owner, expectedRevision, now: this.now() },
        { type: "recover" },
      ).task;
      const result = await readback.call(
        this.options.actuator,
        operation.proposal,
        {
          owner: this.owner,
          signal: controller.signal,
          isCurrent,
        },
      );
      if (!(await stillAuthorized()) || !isCurrent())
        throw new ElizaError("Task changed during readback", {
          code: "TASK_CONFLICT",
        });
      controller.signal.throwIfAborted();
      return this.options.store.transition(
        id,
        {
          owner: this.owner,
          expectedRevision: fence.revision,
          now: this.now(),
        },
        {
          type: "reconcile",
          operationId,
          status: result.status,
          evidenceRef: result.evidenceRef,
        },
      ).task;
    } finally {
      this.pending.delete(id);
      this.startCleanup(id);
      await this.settle(id);
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
        const result = await this.options.actuator.execute(
          structuredClone(proposal),
          { owner: this.owner, signal: controller.signal, isCurrent },
        );
        outcome =
          result.status === "unknown"
            ? { status: "unknown", evidenceRef: result.evidenceRef }
            : { status: result.status, evidenceRef: result.evidenceRef };
        // Validate adapter replies before persisting them. An invalid reply after
        // dispatch is uncertain, never proof that the native effect did not run.
        transitionInteractiveTask(
          dispatched,
          {
            owner: this.owner,
            expectedRevision: dispatched.revision,
            now: this.now(),
          },
          { type: "result", operationId: proposal.id, ...outcome },
        );
      } catch (error) {
        // Lost/error replies are not proof that an effect failed to occur.
        // Only a typed refusal from before the effect resolves the operation.
        outcome =
          (error as { code?: unknown } | null)?.code ===
          TASK_ACTION_NOT_DISPATCHED
            ? { status: "failed", evidenceRef: TASK_ACTION_NOT_DISPATCHED_REF }
            : { status: "unknown" };
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
