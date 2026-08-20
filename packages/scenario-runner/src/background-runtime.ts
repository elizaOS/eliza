/**
 * Drives production TaskService workers under synthetic virtual time for
 * scenario and Cloud E2E hosts, with explicit lifecycle, reset, and quiescence
 * contracts instead of a second scheduler.
 */

import {
  type AgentRuntime,
  ElizaError,
  ServiceType,
  type Task,
  TaskService,
  type TaskWorker,
} from "@elizaos/core";
import {
  type LedgerEntry,
  ObservationLedger,
  payloadHash,
  VirtualClock,
} from "@elizaos/synthetic-world";

export type BackgroundRuntimeState =
  | "created"
  | "running"
  | "paused"
  | "crashed"
  | "stopped";

export interface BackgroundWorkerRequirement {
  readonly name: string;
}

/** Adapter over a production worker that is not registered with TaskService. */
export interface ScenarioBackgroundDriver {
  readonly name: string;
  ready(): Promise<void>;
  step(now: Date): Promise<void>;
  inspect(now: Date): Promise<readonly BackgroundPendingWork[]>;
  reset(): Promise<void>;
  crash?(): Promise<void>;
  restart?(): Promise<void>;
}

const backgroundDrivers = new WeakMap<
  AgentRuntime,
  Map<string, ScenarioBackgroundDriver>
>();

/** Register a scenario adapter around a production queue/cleanup/Cloud processor. */
export function registerScenarioBackgroundDriver(
  runtime: AgentRuntime,
  driver: ScenarioBackgroundDriver,
): () => void {
  const name = driver.name.trim();
  if (!name) throw new TypeError("background driver name must be non-empty");
  const registry = backgroundDrivers.get(runtime) ?? new Map();
  if (registry.has(name)) {
    throw new Error(`background driver ${name} is already registered`);
  }
  registry.set(name, driver);
  backgroundDrivers.set(runtime, registry);
  return () => {
    registry.delete(name);
    if (registry.size === 0) backgroundDrivers.delete(runtime);
  };
}

export interface BackgroundPendingWork {
  readonly id: string;
  readonly name: string;
  readonly dueAt: string | null;
  readonly due: boolean;
  readonly paused: boolean;
}

export interface BackgroundRuntimeInspection {
  readonly state: BackgroundRuntimeState;
  readonly now: string;
  readonly workers: readonly string[];
  readonly pending: readonly BackgroundPendingWork[];
  readonly pendingTimers: number;
  readonly errors: readonly {
    scope: string;
    code: string;
    message: string;
  }[];
  readonly ledger: readonly LedgerEntry[];
}

export interface BackgroundDrainResult {
  readonly quiescent: boolean;
  readonly steps: number;
  readonly pending: readonly BackgroundPendingWork[];
  readonly pendingTimers: number;
}

export interface ScenarioBackgroundRuntimeOptions {
  readonly namespace: string;
  readonly epoch: string | Date;
  readonly workers: readonly (string | BackgroundWorkerRequirement)[];
  readonly workerTasks?: readonly string[];
  readonly ledger?: ObservationLedger;
}

function taskDueAt(task: Task): number | null {
  if (task.dueAt !== undefined) return Number(task.dueAt);
  const scheduledAt = task.metadata?.scheduledAt;
  if (typeof scheduledAt === "number") return scheduledAt;
  if (typeof scheduledAt === "string") {
    const parsed = Date.parse(scheduledAt);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (!task.tags?.includes("repeat")) return null;
  const updatedAt =
    typeof task.metadata?.updatedAt === "number"
      ? task.metadata.updatedAt
      : Number(task.updatedAt ?? 0);
  const interval = task.metadata?.updateInterval;
  if (typeof interval !== "number") return null;
  return updatedAt + interval - (task.metadata?.notBefore ?? 0);
}

function taskId(task: Task, index: number): string {
  return task.id ? String(task.id) : `${task.name}:missing-id:${index}`;
}

function cloneTasks(tasks: readonly Task[]): Task[] {
  return structuredClone(tasks) as Task[];
}

/**
 * Scenario-owned control plane over the existing TaskService. Declared workers
 * are wrapped only for evidence; their production shouldRun/execute functions
 * and durable Task rows remain authoritative.
 */
export class ScenarioBackgroundRuntime {
  readonly clock: VirtualClock;
  readonly ledger: ObservationLedger;

  private stateValue: BackgroundRuntimeState = "created";
  private taskService: TaskService | null = null;
  private baselineTasks: Task[] = [];
  private readonly workerNames: string[];
  private readonly originalWorkers = new Map<string, TaskWorker>();
  private reportedErrorCursor = 0;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly options: ScenarioBackgroundRuntimeOptions,
  ) {
    this.clock = new VirtualClock(options.epoch);
    this.ledger =
      options.ledger ??
      new ObservationLedger(options.namespace, () => this.clock.nowIso());
    this.workerNames = [
      ...new Set(
        options.workers.map((worker) =>
          typeof worker === "string" ? worker.trim() : worker.name.trim(),
        ),
      ),
    ].filter(Boolean);
  }

  get state(): BackgroundRuntimeState {
    return this.stateValue;
  }

  async captureBaseline(): Promise<void> {
    this.baselineTasks = cloneTasks(await this.queueTasks());
  }

  /** Wait for detached plugin-init ensures to materialize declared worker rows. */
  async waitForBaselineReadiness(timeoutMs = 5_000): Promise<void> {
    const requiredRows = [...new Set(this.options.workerTasks ?? [])];
    if (requiredRows.length === 0) return;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const tasks = await this.queueTasks();
      const present = new Set(tasks.map((task) => task.name));
      const missing = requiredRows.filter((name) => !present.has(name));
      if (missing.length === 0) return;
      if (Date.now() >= deadline) {
        throw new ElizaError(
          `Required background task row(s) did not become ready: ${missing.join(", ")}`,
          {
            code: "SCENARIO_BACKGROUND_TASK_ROW_UNAVAILABLE",
            context: { workers: missing, timeoutMs },
            severity: "fatal",
          },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async start(): Promise<void> {
    if (this.stateValue === "running") return;
    const service = await this.runtime.getServiceLoadPromise(ServiceType.TASK);
    if (!(service instanceof TaskService)) {
      throw new ElizaError("Required production TaskService is unavailable", {
        code: "SCENARIO_BACKGROUND_TASK_SERVICE_UNAVAILABLE",
        context: { serviceType: ServiceType.TASK },
        severity: "fatal",
      });
    }
    this.taskService = service;
    await this.assertWorkerReadiness();
    this.wrapDeclaredWorkers();
    await this.taskService.enterManualExecution(() =>
      this.clock.now().getTime(),
    );
    this.reportedErrorCursor = this.runtime.getRecentReportedErrors().length;
    this.stateValue = "running";
    this.appendLifecycle("background-runtime", "started", {
      state: "running",
      workers: this.workerNames.join(","),
    });
  }

  pause(): void {
    this.assertState(["running"], "pause");
    this.stateValue = "paused";
    this.appendLifecycle("background-runtime", "observed", { state: "paused" });
  }

  resume(): void {
    this.assertState(["paused"], "resume");
    this.stateValue = "running";
    this.appendLifecycle("background-runtime", "started", { state: "running" });
  }

  async crash(): Promise<void> {
    this.assertState(["running", "paused"], "crash");
    await Promise.all(this.requiredDrivers().map((driver) => driver.crash?.()));
    this.stateValue = "crashed";
    this.appendLifecycle("background-runtime", "failed", { state: "crashed" });
  }

  async restart(): Promise<void> {
    this.assertState(["crashed"], "restart");
    await this.assertWorkerReadiness();
    await Promise.all(
      this.requiredDrivers().map((driver) => driver.restart?.()),
    );
    this.stateValue = "running";
    this.appendLifecycle("background-runtime", "started", {
      state: "restarted",
    });
  }

  async step(advanceMs = 0): Promise<BackgroundRuntimeInspection> {
    this.assertState(["running"], "step");
    if (!Number.isFinite(advanceMs) || advanceMs < 0) {
      throw new RangeError("background step advanceMs must be non-negative");
    }
    await this.clock.advanceBy(advanceMs);
    this.ledger.append({
      kind: "queue",
      status: "started",
      target: "TaskService.runDueTasks",
      attempt: 1,
      payloadHash: payloadHash({ advanceMs }),
      input: { advanceMs },
    });
    try {
      await this.taskService?.runDueTasks();
      for (const driver of this.requiredDrivers()) {
        this.appendLifecycle(`worker:${driver.name}`, "started", {
          state: "executing",
          attempt: 1,
        });
        try {
          await driver.step(this.clock.now());
          this.appendLifecycle(`worker:${driver.name}`, "succeeded", {
            state: "completed",
            attempt: 1,
          });
        } catch (error) {
          this.appendLifecycle(`worker:${driver.name}`, "failed", {
            state: "failed",
            attempt: 1,
            error: this.errorMessage(error),
          });
          throw error;
        }
      }
      this.ledger.append({
        kind: "queue",
        status: "succeeded",
        target: "TaskService.runDueTasks",
        attempt: 1,
        payloadHash: payloadHash({ now: this.clock.nowIso() }),
        output: { now: this.clock.nowIso() },
      });
    } catch (error) {
      this.ledger.append({
        kind: "queue",
        status: "failed",
        target: "TaskService.runDueTasks",
        attempt: 1,
        payloadHash: payloadHash({ error: this.errorMessage(error) }),
        output: { error: this.errorMessage(error) },
      });
      this.captureReportedErrors();
      throw error;
    }
    this.captureReportedErrors();
    return this.inspect();
  }

  async drain(maxSteps = 100): Promise<BackgroundDrainResult> {
    this.assertState(["running"], "drain");
    if (!Number.isInteger(maxSteps) || maxSteps <= 0) {
      throw new RangeError(
        "background drain maxSteps must be a positive integer",
      );
    }
    let steps = 0;
    let previousSignature = "";
    while (steps < maxSteps) {
      const inspection = await this.inspect();
      const due = inspection.pending.filter((work) => work.due && !work.paused);
      if (due.length === 0 && inspection.pendingTimers === 0) break;
      const signature = payloadHash({
        now: inspection.now,
        due: due.map(({ id, name, dueAt }) => ({ id, name, dueAt })),
        pendingTimers: inspection.pendingTimers,
      });
      if (signature === previousSignature) break;
      previousSignature = signature;
      await this.step();
      steps += 1;
    }
    const inspection = await this.inspect();
    const due = inspection.pending.filter((work) => work.due && !work.paused);
    const quiescent = due.length === 0 && inspection.pendingTimers === 0;
    this.appendLifecycle(
      "background-runtime.drain",
      quiescent ? "succeeded" : "failed",
      {
        state: quiescent ? "quiescent" : "pending",
        pending: inspection.pending.map(({ name }) => name).join(","),
        steps,
      },
    );
    return {
      quiescent,
      steps,
      pending: inspection.pending,
      pendingTimers: inspection.pendingTimers,
    };
  }

  async inspect(): Promise<BackgroundRuntimeInspection> {
    const nowMs = this.clock.now().getTime();
    const tasks = await this.queueTasks();
    const taskPending = tasks.map((task, index): BackgroundPendingWork => {
      const dueMs = taskDueAt(task);
      return {
        id: taskId(task, index),
        name: task.name,
        dueAt: dueMs === null ? null : new Date(dueMs).toISOString(),
        due: dueMs === null || dueMs <= nowMs,
        paused: task.metadata?.paused === true,
      };
    });
    const driverPending = (
      await Promise.all(
        this.requiredDrivers().map((driver) =>
          driver.inspect(this.clock.now()),
        ),
      )
    ).flat();
    return {
      state: this.stateValue,
      now: this.clock.nowIso(),
      workers: [...this.workerNames],
      pending: [...taskPending, ...driverPending],
      pendingTimers: this.clock.pendingTimerCount,
      errors: this.runtime
        .getRecentReportedErrors()
        .slice(this.reportedErrorCursor)
        .map(({ scope, code, message }) => ({ scope, code, message })),
      ledger: this.ledger.all(),
    };
  }

  async resetSharedRuntime(): Promise<void> {
    await this.taskService?.enterManualExecution(() =>
      this.clock.now().getTime(),
    );
    for (const task of await this.queueTasks()) {
      if (task.id) await this.runtime.deleteTask(task.id);
    }
    for (const task of cloneTasks(this.baselineTasks)) {
      await this.runtime.createTask(task);
    }
    await Promise.all(this.requiredDrivers().map((driver) => driver.reset()));
    this.clock.reset(this.options.epoch);
    this.ledger.clear();
    this.reportedErrorCursor = this.runtime.getRecentReportedErrors().length;
    this.stateValue = "paused";
    this.appendLifecycle("background-runtime.reset", "succeeded", {
      state: "paused",
      restoredTasks: this.baselineTasks.length,
    });
  }

  async stop(): Promise<void> {
    if (this.stateValue === "stopped") return;
    this.taskService?.exitManualExecution();
    this.restoreDeclaredWorkers();
    this.stateValue = "stopped";
    this.appendLifecycle("background-runtime", "succeeded", {
      state: "stopped",
    });
  }

  private async queueTasks(): Promise<Task[]> {
    const tasks = await this.runtime.adapter.getTasks({
      tags: ["queue"],
      agentIds: [this.runtime.agentId],
    });
    const agentId = String(this.runtime.agentId);
    return tasks.filter(
      (task) => task.agentId === undefined || String(task.agentId) === agentId,
    );
  }

  private async assertWorkerReadiness(): Promise<void> {
    const drivers = backgroundDrivers.get(this.runtime);
    const missing = this.workerNames.filter(
      (name) =>
        this.runtime.getTaskWorker(name) === undefined && !drivers?.has(name),
    );
    if (missing.length > 0) {
      throw new ElizaError(
        `Required background worker(s) are not registered: ${missing.join(", ")}`,
        {
          code: "SCENARIO_BACKGROUND_WORKER_UNAVAILABLE",
          context: { workers: missing },
          severity: "fatal",
        },
      );
    }
    await Promise.all(this.requiredDrivers().map((driver) => driver.ready()));
  }

  private requiredDrivers(): ScenarioBackgroundDriver[] {
    const drivers = backgroundDrivers.get(this.runtime);
    if (!drivers) return [];
    return this.workerNames.flatMap((name) => {
      const driver = drivers.get(name);
      return driver ? [driver] : [];
    });
  }

  private wrapDeclaredWorkers(): void {
    for (const name of this.workerNames) {
      if (this.originalWorkers.has(name)) continue;
      const original = this.runtime.getTaskWorker(name);
      if (!original) continue;
      this.originalWorkers.set(name, original);
      this.runtime.unregisterTaskWorker(name);
      this.runtime.registerTaskWorker({
        ...original,
        execute: async (runtime, options, task) => {
          const attempt = (task.metadata?.failureCount ?? 0) + 1;
          this.appendLifecycle(`worker:${name}`, "started", {
            state: "executing",
            taskId: String(task.id ?? "missing"),
            attempt,
          });
          try {
            const result = await original.execute(runtime, options, task);
            this.appendLifecycle(`worker:${name}`, "succeeded", {
              state: "completed",
              taskId: String(task.id ?? "missing"),
              attempt,
            });
            return result;
          } catch (error) {
            this.appendLifecycle(`worker:${name}`, "failed", {
              state: "failed",
              taskId: String(task.id ?? "missing"),
              attempt,
              error: this.errorMessage(error),
            });
            throw error;
          }
        },
      });
    }
  }

  private restoreDeclaredWorkers(): void {
    for (const [name, original] of this.originalWorkers) {
      this.runtime.unregisterTaskWorker(name);
      this.runtime.registerTaskWorker(original);
    }
    this.originalWorkers.clear();
  }

  private captureReportedErrors(): void {
    const errors = this.runtime.getRecentReportedErrors();
    for (const error of errors.slice(this.reportedErrorCursor)) {
      this.appendLifecycle(`error:${error.scope}`, "failed", {
        state: "reported",
        code: error.code,
        error: error.message,
      });
    }
    this.reportedErrorCursor = errors.length;
  }

  private appendLifecycle(
    target: string,
    status: "started" | "succeeded" | "failed" | "observed",
    metadata: Record<string, string | number>,
  ): void {
    this.ledger.append({
      kind: "lifecycle",
      status,
      target,
      attempt: typeof metadata.attempt === "number" ? metadata.attempt : 1,
      payloadHash: payloadHash(metadata),
      metadata,
    });
  }

  private assertState(
    allowed: readonly BackgroundRuntimeState[],
    operation: string,
  ): void {
    if (!allowed.includes(this.stateValue)) {
      throw new ElizaError(
        `Cannot ${operation} background runtime while ${this.stateValue}`,
        {
          code: "SCENARIO_BACKGROUND_STATE_INVALID",
          context: { operation, state: this.stateValue, allowed },
        },
      );
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
