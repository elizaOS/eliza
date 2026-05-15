/**
 * TrainingTriggerService — counts completed trajectories per task and fires
 * `triggerTraining` when the configured threshold is reached for a task whose
 * cooldown has elapsed.
 *
 * State is held in-memory and mirrored to disk at
 * `<state>/training/trigger-state.json` so a process restart does not lose
 * progress mid-bucket. The persisted shape is intentionally tiny and
 * forward-compatible: extra keys are ignored on read.
 *
 * Service identifier: `TRAINING_TRIGGER_SERVICE`.
 *
 * Trajectory storage calls `notifyTrajectoryCompleted(trajectoryId)` from
 * `eliza/packages/agent/src/runtime/trajectory-storage.ts` whenever a
 * trajectory transitions to `completed`. The service looks up the trajectory
 * detail, infers the tasks it touches, and increments those counters.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type IAgentRuntime,
  Service,
  type ServiceTypeName,
} from "@elizaos/core";
import type {
  AnonymizerLookup,
  FilterableTrajectory,
} from "../core/privacy-filter.js";
import {
  ALL_TRAINING_TASKS,
  loadTrainingConfig,
  resolveTaskPolicy,
  type TrainingBackend,
  type TrainingConfig,
  trainingStateRoot,
} from "../core/training-config.js";
import {
  type TrainingRunRecord,
  triggerTraining,
} from "../core/training-orchestrator.js";
import type { TrajectoryTrainingTask } from "../core/trajectory-task-datasets.js";

// Extend the core ServiceTypeRegistry so TRAINING_TRIGGER_SERVICE is a known
// service name. This avoids `as never` casts at the registration site and lets
// `runtime.getService` return a typed value via ServiceInstance mapping.
declare module "@elizaos/core" {
  interface ServiceTypeRegistry {
    TRAINING_TRIGGER_SERVICE: "training_trigger_service";
  }
}

export const TRAINING_TRIGGER_SERVICE =
  "training_trigger_service" as ServiceTypeName;

interface MinimalLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

interface TrajectoryServiceLike {
  getTrajectoryDetail: (id: string) => Promise<TrajectoryDetailLike | null>;
}

/**
 * Minimal runtime shape the trigger service + bootstrap helpers depend on.
 * Structurally a subset of `IAgentRuntime`, so full runtimes satisfy it
 * without casts. Tests pass a small shim that matches this shape.
 */
interface RuntimeLike {
  getService: (name: string) => unknown;
  logger?: MinimalLogger;
}

interface TrajectoryStepLike {
  llmCalls?: Array<{
    purpose?: string;
    metadata?: Record<string, unknown>;
    response?: string;
  }>;
}

interface TrajectoryDetailLike extends FilterableTrajectory {
  steps?: TrajectoryStepLike[];
}

export interface TriggerStatusSnapshot {
  autoTrainEnabled: boolean;
  triggerThreshold: number;
  cooldownHours: number;
  counters: Record<TrajectoryTrainingTask, number>;
  lastTrain: Partial<
    Record<
      TrajectoryTrainingTask,
      {
        runId: string;
        source: string;
        finishedAt: string;
        status: string;
      }
    >
  >;
  perTaskThresholds: Record<TrajectoryTrainingTask, number>;
  perTaskCooldownMs: Record<TrajectoryTrainingTask, number>;
}

interface PersistedTriggerState {
  counters: Record<TrajectoryTrainingTask, number>;
  lastTrainAt: Partial<Record<TrajectoryTrainingTask, number>>;
  lastTrainRecord: Partial<
    Record<
      TrajectoryTrainingTask,
      {
        runId: string;
        source: string;
        finishedAt: string;
        status: string;
      }
    >
  >;
}

function emptyCounters(): Record<TrajectoryTrainingTask, number> {
  return {
    should_respond: 0,
    context_routing: 0,
    action_planner: 0,
    response: 0,
    media_description: 0,
  };
}

function isStringRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readPersisted(path: string): PersistedTriggerState {
  if (!existsSync(path)) {
    return {
      counters: emptyCounters(),
      lastTrainAt: {},
      lastTrainRecord: {},
    };
  }
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw);
  const counters = emptyCounters();
  if (isStringRecord(parsed) && isStringRecord(parsed.counters)) {
    for (const task of ALL_TRAINING_TASKS) {
      const value = parsed.counters[task];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        counters[task] = Math.floor(value);
      }
    }
  }
  const lastTrainAt: Partial<Record<TrajectoryTrainingTask, number>> = {};
  if (isStringRecord(parsed) && isStringRecord(parsed.lastTrainAt)) {
    for (const task of ALL_TRAINING_TASKS) {
      const value = parsed.lastTrainAt[task];
      if (typeof value === "number" && Number.isFinite(value)) {
        lastTrainAt[task] = value;
      }
    }
  }
  const lastTrainRecord: PersistedTriggerState["lastTrainRecord"] = {};
  if (isStringRecord(parsed) && isStringRecord(parsed.lastTrainRecord)) {
    for (const task of ALL_TRAINING_TASKS) {
      const value = parsed.lastTrainRecord[task];
      if (
        isStringRecord(value) &&
        typeof value.runId === "string" &&
        typeof value.source === "string" &&
        typeof value.finishedAt === "string" &&
        typeof value.status === "string"
      ) {
        lastTrainRecord[task] = {
          runId: value.runId,
          source: value.source,
          finishedAt: value.finishedAt,
          status: value.status,
        };
      }
    }
  }
  return { counters, lastTrainAt, lastTrainRecord };
}

function writePersisted(path: string, state: PersistedTriggerState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function tasksForTrajectory(
  detail: TrajectoryDetailLike,
): TrajectoryTrainingTask[] {
  const tasks = new Set<TrajectoryTrainingTask>();
  for (const step of detail.steps ?? []) {
    for (const call of step.llmCalls ?? []) {
      const purpose = (call.purpose ?? "").toLowerCase();
      const callKind =
        typeof call.metadata?.callKind === "string"
          ? call.metadata.callKind.toLowerCase()
          : "";
      const hint = `${purpose} ${callKind}`;
      if (
        hint.includes("should_respond") ||
        hint.includes("response_handler") ||
        hint.includes("shouldrespond")
      ) {
        tasks.add("should_respond");
      }
      if (
        hint.includes("action_planner") ||
        hint.includes("planner") ||
        hint.includes("runtime_use_model")
      ) {
        tasks.add("action_planner");
      }
      if (
        hint.includes("media_description") ||
        hint.includes("image_description") ||
        hint.includes("describe_")
      ) {
        tasks.add("media_description");
      }
      if (
        hint.includes("response") ||
        hint.includes("reply") ||
        hint.includes("message_response")
      ) {
        tasks.add("response");
      }
      if (
        typeof call.response === "string" &&
        /context_routing/i.test(call.response)
      ) {
        tasks.add("context_routing");
      }
    }
  }
  // Default: a trajectory with any LLM call counts toward `response`.
  if (tasks.size === 0 && (detail.steps?.length ?? 0) > 0) {
    tasks.add("response");
  }
  return [...tasks];
}

export interface TrainingTriggerServiceOptions {
  /** Defaults to <state>/training/trigger-state.json. */
  statePath?: string;
  /** Override config loader (tests). */
  configLoader?: () => TrainingConfig;
  /** Forward to the orchestrator (tests). */
  triggerImpl?: typeof triggerTraining;
  /** Anonymizer forwarded to the orchestrator. */
  anonymizer?: AnonymizerLookup;
  /** Clock injection (tests). */
  now?: () => number;
}

/**
 * Lightweight service registered directly into the runtime service map. It has
 * no `start()` lifecycle, but extends the core base class so the registration
 * stays assignable to the runtime's `Service[]` registry.
 */
export class TrainingTriggerService extends Service {
  readonly capabilityDescription =
    "Tracks completed trajectories and fires training runs when per-task counters hit the configured threshold.";
  readonly instance = this;

  private readonly runtimeRef: RuntimeLike;
  private readonly statePath: string;
  private readonly configLoader: () => TrainingConfig;
  private readonly triggerImpl: typeof triggerTraining;
  private readonly anonymizer?: AnonymizerLookup;
  private readonly now: () => number;
  private readonly inflight = new Set<TrajectoryTrainingTask>();
  private state: PersistedTriggerState;

  constructor(
    runtime: RuntimeLike,
    options: TrainingTriggerServiceOptions = {},
  ) {
    super();
    this.runtimeRef = runtime;
    this.statePath =
      options.statePath ?? join(trainingStateRoot(), "trigger-state.json");
    this.configLoader = options.configLoader ?? loadTrainingConfig;
    this.triggerImpl = options.triggerImpl ?? triggerTraining;
    this.anonymizer = options.anonymizer;
    this.now = options.now ?? (() => Date.now());
    this.state = readPersisted(this.statePath);
  }

  /**
   * Idempotent no-op; kept so callers can swap the service into a `Service`
   * subclass later without changing the registration site.
   */
  async stop(): Promise<void> {}

  getStatus(): TriggerStatusSnapshot {
    const config = this.configLoader();
    const perTaskThresholds: Record<TrajectoryTrainingTask, number> = {
      should_respond: 0,
      context_routing: 0,
      action_planner: 0,
      response: 0,
      media_description: 0,
    };
    const perTaskCooldownMs: Record<TrajectoryTrainingTask, number> = {
      should_respond: 0,
      context_routing: 0,
      action_planner: 0,
      response: 0,
      media_description: 0,
    };
    for (const task of ALL_TRAINING_TASKS) {
      const policy = resolveTaskPolicy(config, task);
      perTaskThresholds[task] = policy.threshold;
      perTaskCooldownMs[task] = policy.cooldownMs;
    }
    return {
      autoTrainEnabled: config.autoTrain,
      triggerThreshold: config.triggerThreshold,
      cooldownHours: config.triggerCooldownHours,
      counters: { ...this.state.counters },
      lastTrain: { ...this.state.lastTrainRecord },
      perTaskThresholds,
      perTaskCooldownMs,
    };
  }

  /**
   * Called by trajectory storage when a trajectory transitions to
   * `completed`. Looks up the detail, increments the relevant counters, and
   * checks each touched task's threshold + cooldown.
   *
   * Errors propagate by design — the caller passes through optional chaining
   * so a missing service is a no-op, but a misconfigured service that throws
   * during increment should not be silently lost.
   */
  async notifyTrajectoryCompleted(trajectoryId: string): Promise<void> {
    if (!trajectoryId.trim()) return;
    const config = this.configLoader();
    if (!config.autoTrain) return;

    const trajectoryService = this.runtimeRef.getService(
      "trajectories",
    ) as TrajectoryServiceLike | null;
    if (
      !trajectoryService ||
      typeof trajectoryService.getTrajectoryDetail !== "function"
    ) {
      return;
    }
    const detail = await trajectoryService.getTrajectoryDetail(trajectoryId);
    if (!detail) return;

    const tasks = tasksForTrajectory(detail);
    if (tasks.length === 0) return;

    let dirty = false;
    for (const task of tasks) {
      this.state.counters[task] = (this.state.counters[task] ?? 0) + 1;
      dirty = true;
    }
    if (dirty) writePersisted(this.statePath, this.state);

    for (const task of tasks) {
      await this.maybeFire(task, config);
    }
  }

  /** Manual fire — bypasses the autoTrain toggle (operator action). */
  async runManually(input: {
    task?: TrajectoryTrainingTask;
    backend?: TrainingBackend;
    dryRun?: boolean;
  }): Promise<TrainingRunRecord> {
    const record = await this.triggerImpl(this.runtimeRef, {
      task: input.task,
      backend: input.backend,
      source: "manual",
      dryRun: input.dryRun,
      anonymizer: this.anonymizer,
    });
    this.recordCompletion(record);
    return record;
  }

  /**
   * Reset counters — primarily for tests and operator recovery. The persisted
   * `lastTrainAt`/`lastTrainRecord` map is preserved so cooldowns still
   * apply after a reset.
   */
  resetCounters(task?: TrajectoryTrainingTask): void {
    if (task) {
      this.state.counters[task] = 0;
    } else {
      this.state.counters = emptyCounters();
    }
    writePersisted(this.statePath, this.state);
  }

  private async maybeFire(
    task: TrajectoryTrainingTask,
    config: TrainingConfig,
  ): Promise<void> {
    const policy = resolveTaskPolicy(config, task);
    const count = this.state.counters[task];
    if (count < policy.threshold) return;
    const lastAt = this.state.lastTrainAt[task];
    const now = this.now();
    if (typeof lastAt === "number" && now - lastAt < policy.cooldownMs) {
      return;
    }
    if (this.inflight.has(task)) return;
    this.inflight.add(task);
    const log: MinimalLogger = this.runtimeRef.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    log.info(
      `[TrainingTriggerService] firing task=${task} threshold=${policy.threshold} count=${count} backend=${policy.backend ?? "<none>"}`,
    );
    try {
      const record = await this.triggerImpl(this.runtimeRef, {
        task,
        source: "threshold",
        anonymizer: this.anonymizer,
      });
      this.recordCompletion(record);
      // Reset the counter for this task once the run completes (succeeded,
      // failed, or skipped). Skipped runs still consume the burst — operator
      // can lower threshold or change backend if they want immediate retries.
      this.state.counters[task] = 0;
      writePersisted(this.statePath, this.state);
    } finally {
      this.inflight.delete(task);
    }
  }

  private recordCompletion(record: TrainingRunRecord): void {
    if (!record.task) return;
    this.state.lastTrainAt[record.task] = this.now();
    this.state.lastTrainRecord[record.task] = {
      runId: record.runId,
      source: record.source,
      finishedAt: record.finishedAt,
      status: record.status,
    };
    writePersisted(this.statePath, this.state);
  }
}

/**
 * Registered entry shape — kept as a standalone interface so callers that
 * `getService(TRAINING_TRIGGER_SERVICE)` can type the result without
 * importing the concrete class.
 */
export interface RegisteredTrainingTriggerEntry extends Service {
  notifyTrajectoryCompleted: (trajectoryId: string) => Promise<void>;
  getStatus: () => TriggerStatusSnapshot;
  runManually: (input: {
    task?: TrajectoryTrainingTask;
    backend?: TrainingBackend;
    dryRun?: boolean;
  }) => Promise<TrainingRunRecord>;
  resetCounters: (task?: TrajectoryTrainingTask) => void;
  stop: () => Promise<void>;
  capabilityDescription: string;
  instance: TrainingTriggerService;
}

/**
 * Register the service against a runtime's services map. Mirrors the
 * workflow-dispatch pattern in `packages/app-core/src/runtime/eliza.ts`: we
 * insert a function-shaped service entry directly rather than going through
 * the `Service.start()` lifecycle, which expects a class.
 *
 * Safe to call multiple times — subsequent calls replace the entry.
 */
export function registerTrainingTriggerService(
  runtime: IAgentRuntime,
  options: TrainingTriggerServiceOptions = {},
): TrainingTriggerService {
  const service = new TrainingTriggerService(runtime, options);
  runtime.services.set(TRAINING_TRIGGER_SERVICE, [service]);
  return service;
}

const BOOTSTRAP_TASKS: readonly TrajectoryTrainingTask[] = [
  "should_respond",
  "action_planner",
] as const;

interface OptimizedPromptServiceLike {
  hasOptimized: (task: TrajectoryTrainingTask) => boolean;
}

function hasOptimizedPromptService(
  service: Service | null,
): service is Service & OptimizedPromptServiceLike {
  return (
    !!service &&
    typeof (service as { hasOptimized?: unknown }).hasOptimized === "function"
  );
}

interface UserNotifier {
  notify: (message: string) => void;
}

export interface BootstrapOptimizationOptions {
  configLoader?: () => TrainingConfig;
  notifier?: UserNotifier;
  /**
   * Override the service used to trigger the run. Tests pass a stub; in
   * production the registered TrainingTriggerService is looked up from
   * runtime.services.
   */
  triggerOverride?: (input: {
    task: TrajectoryTrainingTask;
    backend: TrainingBackend;
  }) => Promise<TrainingRunRecord>;
}

/**
 * One-shot bootstrap pass for default-on Hermes parity.
 *
 * Called immediately after `registerTrainingTriggerService` during runtime
 * boot. For each high-leverage task (should_respond + action_planner):
 *   - If `ELIZA_DISABLE_AUTO_BOOTSTRAP=1`, do nothing.
 *   - If the OptimizedPromptService already has an artifact for the task,
 *     do nothing (the operator's previous run wins).
 *   - If the per-task trajectory counter is below the threshold, do nothing
 *     (we don't want to optimize against a thin dataset).
 *   - Otherwise, fire `triggerTraining({ source: 'bootstrap', backend: 'native' })`
 *     and notify the user that progress can be tracked in
 *     Settings → Auto-Training.
 *
 * This is fire-and-forget on purpose: the runtime boot must not block on
 * an LLM-driven optimization round. Errors propagate so the boot logger
 * surfaces them rather than swallowing them silently.
 */
export async function bootstrapOptimizationFromAccumulatedTrajectories(
  runtime: IAgentRuntime,
  service: TrainingTriggerService,
  options: BootstrapOptimizationOptions = {},
): Promise<TrajectoryTrainingTask[]> {
  if (process.env.ELIZA_DISABLE_AUTO_BOOTSTRAP === "1") {
    return [];
  }
  const config = (options.configLoader ?? loadTrainingConfig)();
  if (!config.autoTrain) return [];
  if (!config.backends.includes("native")) return [];

  const optimizedPromptService = runtime.getService("optimized_prompt");

  const status = service.getStatus();
  const fired: TrajectoryTrainingTask[] = [];
  for (const task of BOOTSTRAP_TASKS) {
    const threshold =
      status.perTaskThresholds[task] ?? Number.POSITIVE_INFINITY;
    const count = status.counters[task] ?? 0;
    if (count < threshold) continue;
    if (
      hasOptimizedPromptService(optimizedPromptService) &&
      optimizedPromptService.hasOptimized(task)
    ) {
      continue;
    }
    const trigger =
      options.triggerOverride ??
      (async (input) =>
        service.runManually({ task: input.task, backend: input.backend }));
    await trigger({ task, backend: "native" });
    fired.push(task);
  }

  if (fired.length > 0) {
    const message = `Bootstrapping prompt optimization from accumulated trajectories (${fired.join(", ")}). Track progress in Settings → Auto-Training.`;
    options.notifier?.notify(message);
    runtime.logger?.info(`[TrainingTriggerService] ${message}`);
  }
  return fired;
}
