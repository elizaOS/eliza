import crypto from "node:crypto";
import type { IAgentRuntime, Task, UUID } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import {
  buildTriggerMetadata,
  DISABLED_TRIGGER_INTERVAL_MS,
  MAX_TRIGGER_RUN_HISTORY,
} from "./scheduling";
import type {
  TriggerConfig,
  TriggerHealthSnapshot,
  TriggerRunRecord,
  TriggerSummary,
  TriggerTaskMetadata,
} from "./types";

export const TRIGGER_TASK_NAME = "TRIGGER_DISPATCH" as const;
export const TRIGGER_TASK_TAGS = ["queue", "repeat", "trigger"] as const;

const DEFAULT_MAX_ACTIVE_TRIGGERS = 100;

interface TriggerMetricsState {
  totalExecutions: number;
  totalFailures: number;
  totalSkipped: number;
  lastExecutionAt?: number;
}

export interface TriggerExecutionOptions {
  source: "scheduler" | "manual";
  force?: boolean;
}

export interface TriggerExecutionResult {
  status: "success" | "error" | "skipped";
  error?: string;
  taskDeleted: boolean;
  runRecord?: TriggerRunRecord;
}

const metricsByAgent = new Map<UUID, TriggerMetricsState>();

function getMetrics(agentId: UUID): TriggerMetricsState {
  const current = metricsByAgent.get(agentId);
  if (current) return current;
  const created: TriggerMetricsState = {
    totalExecutions: 0,
    totalFailures: 0,
    totalSkipped: 0,
  };
  metricsByAgent.set(agentId, created);
  return created;
}

function recordExecutionMetric(
  agentId: UUID,
  status: TriggerExecutionResult["status"],
  ts: number,
): void {
  const metrics = getMetrics(agentId);
  if (status === "success" || status === "error") {
    metrics.totalExecutions += 1;
    metrics.lastExecutionAt = ts;
  }
  if (status === "error") {
    metrics.totalFailures += 1;
  }
  if (status === "skipped") {
    metrics.totalSkipped += 1;
  }
}

function appendRunRecord(
  existing: TriggerRunRecord[] | undefined,
  record: TriggerRunRecord,
): TriggerRunRecord[] {
  const runs = [...(existing ?? []), record];
  return runs.length <= MAX_TRIGGER_RUN_HISTORY
    ? runs
    : runs.slice(runs.length - MAX_TRIGGER_RUN_HISTORY);
}

function taskMetadata(task: Task): TriggerTaskMetadata {
  return (task.metadata ?? {}) as TriggerTaskMetadata;
}

export function readTriggerConfig(task: Task): TriggerConfig | null {
  const trigger = taskMetadata(task).trigger;
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger))
    return null;
  return (trigger as TriggerConfig).triggerId
    ? (trigger as TriggerConfig)
    : null;
}

export function readTriggerRuns(task: Task): TriggerRunRecord[] {
  const runs = taskMetadata(task).triggerRuns;
  return Array.isArray(runs) ? (runs as TriggerRunRecord[]) : [];
}

export function triggersFeatureEnabled(runtime?: IAgentRuntime): boolean {
  const runtimeSetting = runtime?.getSetting("MILADY_TRIGGERS_ENABLED");
  if (
    runtimeSetting === false ||
    runtimeSetting === "false" ||
    runtimeSetting === "0"
  ) {
    return false;
  }
  const env = process.env.MILADY_TRIGGERS_ENABLED;
  if (!env) return true;
  const normalized = env.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false";
}

export function getTriggerLimit(runtime?: IAgentRuntime): number {
  const runtimeSetting = runtime?.getSetting("MILADY_TRIGGERS_MAX_ACTIVE");
  if (typeof runtimeSetting === "number" && Number.isFinite(runtimeSetting)) {
    return Math.max(1, Math.floor(runtimeSetting));
  }
  if (typeof runtimeSetting === "string" && /^\d+$/.test(runtimeSetting)) {
    return Math.max(1, Number(runtimeSetting));
  }
  const env = process.env.MILADY_TRIGGERS_MAX_ACTIVE;
  if (env && /^\d+$/.test(env)) {
    return Math.max(1, Number(env));
  }
  return DEFAULT_MAX_ACTIVE_TRIGGERS;
}

function isAutonomyServiceAvailable(runtime: IAgentRuntime): boolean {
  const svc =
    (runtime.getService("autonomy") as Record<string, unknown> | null) ??
    (runtime.getService("AUTONOMY") as Record<string, unknown> | null);
  return typeof svc?.injectAutonomousInstruction === "function";
}

async function dispatchInstruction(
  runtime: IAgentRuntime,
  taskId: UUID,
  trigger: TriggerConfig,
): Promise<void> {
  type TriggerAutonomyService = {
    getAutonomousRoomId?: () => UUID;
    injectAutonomousInstruction?: (payload: {
      instructions: string;
      source: string;
      wakeMode: TriggerConfig["wakeMode"];
      triggerId: UUID;
      triggerTaskId: UUID;
      taskId?: UUID;
      roomId?: UUID;
    }) => Promise<void> | void;
  };
  const autonomyService =
    (runtime.getService("autonomy") as TriggerAutonomyService | null) ??
    (runtime.getService("AUTONOMY") as TriggerAutonomyService | null);

  if (!autonomyService?.injectAutonomousInstruction) {
    runtime.logger.warn?.(
      `Autonomy service missing injectAutonomousInstruction (taskId=${taskId}, triggerId=${trigger.triggerId})`,
    );
    throw new Error("Autonomy service unavailable for trigger dispatch");
  }

  const roomId =
    typeof autonomyService.getAutonomousRoomId === "function"
      ? autonomyService.getAutonomousRoomId()
      : undefined;

  await autonomyService.injectAutonomousInstruction({
    instructions: trigger.instructions,
    source: "trigger-runtime",
    wakeMode: trigger.wakeMode,
    triggerId: trigger.triggerId,
    triggerTaskId: taskId,
    taskId,
    roomId,
  });
}

export async function executeTriggerTask(
  runtime: IAgentRuntime,
  task: Task,
  options: TriggerExecutionOptions,
): Promise<TriggerExecutionResult> {
  if (!task.id) {
    return { status: "skipped", taskDeleted: false };
  }

  const trigger = readTriggerConfig(task);
  if (!trigger) {
    recordExecutionMetric(runtime.agentId, "skipped", Date.now());
    return { status: "skipped", taskDeleted: false };
  }

  if (!trigger.enabled && !options.force) {
    recordExecutionMetric(runtime.agentId, "skipped", Date.now());
    return { status: "skipped", taskDeleted: false };
  }

  if (
    typeof trigger.maxRuns === "number" &&
    trigger.maxRuns > 0 &&
    trigger.runCount >= trigger.maxRuns
  ) {
    await runtime.deleteTask(task.id);
    recordExecutionMetric(runtime.agentId, "skipped", Date.now());
    return { status: "skipped", taskDeleted: true };
  }

  if (!isAutonomyServiceAvailable(runtime) && options.source !== "manual") {
    runtime.logger.warn?.(
      {
        src: "trigger-runtime",
        taskId: task.id,
        triggerId: trigger.triggerId,
      },
      "Autonomy service unavailable — skipping trigger (will retry next cycle)",
    );
    recordExecutionMetric(runtime.agentId, "skipped", Date.now());
    return { status: "skipped", taskDeleted: false };
  }

  const startedAt = Date.now();
  let status: TriggerExecutionResult["status"] = "success";
  let errorMessage = "";

  try {
    await dispatchInstruction(runtime, task.id, trigger);
  } catch (error) {
    status = "error";
    errorMessage = error instanceof Error ? error.message : String(error);
    runtime.logger.error(
      {
        src: "trigger-runtime",
        agentId: runtime.agentId,
        taskId: task.id,
        triggerId: trigger.triggerId,
        error: errorMessage,
      },
      "Trigger execution failed",
    );
  }

  if (status === "success") {
    runtime.logger.info(
      {
        src: "trigger-runtime",
        triggerId: trigger.triggerId,
        triggerName: trigger.displayName,
        triggerType: trigger.triggerType,
        source: options.source,
        latencyMs: Date.now() - startedAt,
      },
      `Trigger "${trigger.displayName}" executed successfully`,
    );
  }

  const finishedAt = Date.now();
  const runRecord: TriggerRunRecord = {
    triggerRunId: stringToUuid(crypto.randomUUID()),
    triggerId: trigger.triggerId,
    taskId: task.id,
    startedAt,
    finishedAt,
    status,
    error: errorMessage || undefined,
    latencyMs: finishedAt - startedAt,
    source: options.source,
  };

  const updatedTrigger: TriggerConfig = {
    ...trigger,
    runCount: trigger.runCount + 1,
    lastRunAtIso: new Date(finishedAt).toISOString(),
    lastStatus: status,
    lastError: errorMessage || undefined,
  };

  if (
    updatedTrigger.triggerType === "once" ||
    (typeof updatedTrigger.maxRuns === "number" &&
      updatedTrigger.maxRuns > 0 &&
      updatedTrigger.runCount >= updatedTrigger.maxRuns)
  ) {
    await runtime.deleteTask(task.id);
    recordExecutionMetric(runtime.agentId, status, finishedAt);
    return {
      status,
      error: errorMessage || undefined,
      runRecord,
      taskDeleted: true,
    };
  }

  const existingMetadata = taskMetadata(task);
  const nextMetadata = buildTriggerMetadata({
    existingMetadata,
    trigger: updatedTrigger,
    nowMs: finishedAt,
  });

  let metadataToPersist: TriggerTaskMetadata;
  if (!nextMetadata) {
    metadataToPersist = {
      ...existingMetadata,
      updatedAt: finishedAt,
      updateInterval: DISABLED_TRIGGER_INTERVAL_MS,
      trigger: {
        ...updatedTrigger,
        enabled: false,
        nextRunAtMs: finishedAt + DISABLED_TRIGGER_INTERVAL_MS,
        lastError:
          updatedTrigger.lastError ?? "Failed to compute next trigger schedule",
      },
      triggerRuns: appendRunRecord(existingMetadata.triggerRuns, runRecord),
    };
  } else {
    metadataToPersist = {
      ...nextMetadata,
      triggerRuns: appendRunRecord(existingMetadata.triggerRuns, runRecord),
    };
  }

  await runtime.updateTask(task.id, {
    description: metadataToPersist.trigger?.displayName ?? task.description,
    metadata: metadataToPersist,
  });

  recordExecutionMetric(runtime.agentId, status, finishedAt);
  return {
    status,
    error: errorMessage || undefined,
    runRecord,
    taskDeleted: false,
  };
}

export function registerTriggerTaskWorker(runtime: IAgentRuntime): void {
  if (runtime.getTaskWorker(TRIGGER_TASK_NAME)) return;

  runtime.registerTaskWorker({
    name: TRIGGER_TASK_NAME,
    validate: async () => true,
    execute: async (rt, options, task) => {
      await executeTriggerTask(rt, task, {
        source: options.source === "manual" ? "manual" : "scheduler",
        force: options.force === true,
      });
    },
  });
}

export async function listTriggerTasks(
  runtime: IAgentRuntime,
): Promise<Task[]> {
  if (!triggersFeatureEnabled(runtime)) return [];
  return runtime.getTasks({
    tags: [...TRIGGER_TASK_TAGS],
  });
}

export function taskToTriggerSummary(task: Task): TriggerSummary | null {
  const trigger = readTriggerConfig(task);
  if (!trigger || !task.id) return null;
  const metadata = taskMetadata(task);
  return {
    id: trigger.triggerId,
    taskId: task.id,
    displayName: trigger.displayName,
    instructions: trigger.instructions,
    triggerType: trigger.triggerType,
    enabled: trigger.enabled,
    wakeMode: trigger.wakeMode,
    createdBy: trigger.createdBy,
    timezone: trigger.timezone,
    intervalMs: trigger.intervalMs,
    scheduledAtIso: trigger.scheduledAtIso,
    cronExpression: trigger.cronExpression,
    maxRuns: trigger.maxRuns,
    runCount: trigger.runCount,
    nextRunAtMs: trigger.nextRunAtMs,
    lastRunAtIso: trigger.lastRunAtIso,
    lastStatus: trigger.lastStatus,
    lastError: trigger.lastError,
    updatedAt: metadata.updatedAt,
    updateInterval: metadata.updateInterval,
  };
}

export async function getTriggerHealthSnapshot(
  runtime: IAgentRuntime,
): Promise<TriggerHealthSnapshot> {
  const tasks = await listTriggerTasks(runtime);
  let activeTriggers = 0;
  let disabledTriggers = 0;

  let durableExecutions = 0;
  let durableFailures = 0;
  let durableLastExecAt: number | undefined;

  for (const task of tasks) {
    const trigger = readTriggerConfig(task);
    if (!trigger) continue;
    if (trigger.enabled) {
      activeTriggers += 1;
    } else {
      disabledTriggers += 1;
    }

    const runs = readTriggerRuns(task);
    for (const run of runs) {
      durableExecutions += 1;
      if (run.status === "error") durableFailures += 1;
      if (!durableLastExecAt || run.finishedAt > durableLastExecAt) {
        durableLastExecAt = run.finishedAt;
      }
    }
  }

  const inMemory = getMetrics(runtime.agentId);
  return {
    triggersEnabled: triggersFeatureEnabled(runtime),
    activeTriggers,
    disabledTriggers,
    totalExecutions: Math.max(inMemory.totalExecutions, durableExecutions),
    totalFailures: Math.max(inMemory.totalFailures, durableFailures),
    totalSkipped: inMemory.totalSkipped,
    lastExecutionAt: inMemory.lastExecutionAt ?? durableLastExecAt,
  };
}
