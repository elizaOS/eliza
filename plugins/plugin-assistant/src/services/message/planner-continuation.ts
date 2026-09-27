/** Durable, explicitly resumed planner work owned by the existing task scheduler. */
import {
  type Content,
  ElizaError,
  type IAgentRuntime,
  isObjectRecord,
  type Memory,
  mergeChainingLoopConfig,
  type PlannerLoopResult,
  type PlannerTrajectory,
  stringToUuid,
  type Task,
  type UUID,
} from "@elizaos/core";
import { resolveStage1SenderRole } from "./addressing.js";

export const PLANNER_CONTINUATION_TASK = "PLANNER_CONTINUATION";
export const RESUME_PLANNER_OPTION = "RESUME_WITH_ADDITIONAL_BUDGET";
export const CANCEL_PLANNER_OPTION = "CANCEL_CONTINUATION";
type Usage = NonNullable<PlannerLoopResult["modelUsage"]>;
export type PlannerResumeState = {
  trajectory: PlannerTrajectory;
  modelUsage: Usage;
};
export interface PlannerContinuation {
  version: 1;
  taskId: UUID;
  agentId: UUID;
  original: Memory;
  state: PlannerResumeState;
  authorizedTotalPromptBudget: number;
  additionalPromptBudget: number;
  attempt: number;
  phase:
    | "paused"
    | "queued"
    | "running"
    | "executing"
    | "delivery_pending"
    | "delivered"
    | "cancelled"
    | "blocked";
  failure?: {
    code:
      | "PLANNER_CONTINUATION_EXECUTION_FAILED"
      | "PLANNER_CONTINUATION_INTERRUPTED";
  };
  delivery?: { id: UUID; content: Content; acknowledged: boolean };
  deliveries?: Array<{ id: UUID; content: Content; acknowledged: boolean }>;
}
const bindings = new WeakMap<IAgentRuntime, Map<string, PlannerContinuation>>();
const running = new WeakMap<IAgentRuntime, Set<string>>();
const mutations = new WeakMap<IAgentRuntime, Map<string, Promise<void>>>();
const controllers = new WeakMap<IAgentRuntime, Map<string, AbortController>>();
const recovered = new WeakMap<IAgentRuntime, Promise<void>>();
function invalid(message: string): never {
  throw new ElizaError(message, { code: "PLANNER_CONTINUATION_INVALID" });
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function getActivePlannerContinuation(
  runtime: IAgentRuntime,
  message: Memory,
): PlannerContinuation | undefined {
  const value = message.id ? bindings.get(runtime)?.get(message.id) : undefined;
  if (
    value &&
    (value.agentId !== runtime.agentId ||
      value.original.roomId !== message.roomId ||
      value.original.entityId !== message.entityId)
  )
    invalid("Continuation scope changed");
  return value;
}

function readCheckpoint(
  runtime: IAgentRuntime,
  task: Task,
): PlannerContinuation {
  const value = task.metadata?.plannerContinuation;
  if (
    !isObjectRecord(value) ||
    value.version !== 1 ||
    value.agentId !== runtime.agentId ||
    task.agentId !== runtime.agentId ||
    value.taskId !== task.id ||
    !isObjectRecord(value.original) ||
    value.original.roomId !== task.roomId ||
    value.original.entityId !== task.entityId ||
    !isObjectRecord(value.state) ||
    !isObjectRecord(value.state.trajectory) ||
    !Array.isArray(value.state.trajectory.steps) ||
    !Array.isArray(value.state.trajectory.archivedSteps) ||
    !Array.isArray(value.state.trajectory.plannedQueue) ||
    (value.state.trajectory.outcomeIntents !== undefined &&
      (!Array.isArray(value.state.trajectory.outcomeIntents) ||
        !value.state.trajectory.outcomeIntents.every(
          (intent: unknown) => typeof intent === "string",
        ))) ||
    !isObjectRecord(value.state.modelUsage)
  )
    invalid("Invalid or foreign planner checkpoint");
  for (const key of ["promptTokens", "completionTokens", "modelCalls"]) {
    const count = value.state.modelUsage[key];
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0)
      invalid("Invalid continuation usage");
  }
  if (
    typeof value.authorizedTotalPromptBudget !== "number" ||
    !Number.isFinite(value.authorizedTotalPromptBudget) ||
    value.authorizedTotalPromptBudget <= 0 ||
    typeof value.additionalPromptBudget !== "number" ||
    !Number.isFinite(value.additionalPromptBudget) ||
    value.additionalPromptBudget <= 0 ||
    typeof value.attempt !== "number" ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 0
  )
    invalid("Invalid continuation budget");
  return clone(value) as unknown as PlannerContinuation;
}

async function persistUnlocked(
  runtime: IAgentRuntime,
  checkpoint: PlannerContinuation,
  expected?: { phase: PlannerContinuation["phase"]; attempt: number },
): Promise<boolean> {
  const task = await runtime.getTask(checkpoint.taskId);
  if (!task || task.agentId !== runtime.agentId)
    invalid("Continuation task is missing");
  const previous = readCheckpoint(runtime, task);
  if (
    expected &&
    (previous.phase !== expected.phase || previous.attempt !== expected.attempt)
  )
    return false;
  if (previous.phase === "cancelled" && checkpoint.phase !== "cancelled")
    invalid("Continuation was cancelled");
  if (checkpoint.phase === "queued" && previous.phase !== "paused")
    invalid("Continuation is no longer paused");
  // An ambiguous execution/delivery checkpoint that failed or was orphaned by
  // a restart is never replayed; the owner can still cancel what remains.
  const parkedAmbiguous =
    (checkpoint.phase === "executing" ||
      checkpoint.phase === "delivery_pending") &&
    checkpoint.failure !== undefined;
  const cancelOption = {
    name: CANCEL_PLANNER_OPTION,
    description: "Cancel remaining work; preserve completed effects.",
  };
  await runtime.updateTask(checkpoint.taskId, {
    metadata: {
      ...task.metadata,
      plannerContinuation: clone(checkpoint),
      paused: checkpoint.phase !== "queued",
      status: checkpoint.phase,
      options:
        checkpoint.phase === "paused"
          ? [
              {
                name: RESUME_PLANNER_OPTION,
                description: `Resume unfinished work with ${checkpoint.additionalPromptBudget} additional prompt tokens; prior usage is retained.`,
              },
              cancelOption,
            ]
          : parkedAmbiguous
            ? [cancelOption]
            : undefined,
    },
    tags:
      checkpoint.phase === "queued"
        ? ["queue", "planner-continuation"]
        : checkpoint.phase === "paused" || parkedAmbiguous
          ? ["AWAITING_CHOICE", "planner-continuation"]
          : ["planner-continuation"],
    dueAt: checkpoint.phase === "queued" ? Date.now() : null,
  });
  return true;
}

// Serialize lifecycle writes within the existing single-runtime task owner.
// The task API has no distributed CAS; this is not a cross-host execution lease.
async function persist(
  runtime: IAgentRuntime,
  checkpoint: PlannerContinuation,
  expected?: { phase: PlannerContinuation["phase"]; attempt: number },
): Promise<boolean> {
  let pending = mutations.get(runtime);
  if (!pending) {
    pending = new Map();
    mutations.set(runtime, pending);
  }
  const predecessor = pending.get(checkpoint.taskId) ?? Promise.resolve();
  const operation = predecessor.then(() =>
    persistUnlocked(runtime, checkpoint, expected),
  );
  const settled = operation.then(
    () => undefined,
    () => undefined,
  );
  pending.set(checkpoint.taskId, settled);
  try {
    return await operation;
  } finally {
    if (pending.get(checkpoint.taskId) === settled)
      pending.delete(checkpoint.taskId);
  }
}

export async function persistPlannerContinuation(
  runtime: IAgentRuntime,
  message: Memory,
  result: PlannerLoopResult,
  maxPromptTokens?: number,
): Promise<void> {
  const active = getActivePlannerContinuation(runtime, message);
  if (active) {
    active.state = clone({
      trajectory: result.trajectory,
      modelUsage: result.modelUsage ?? active.state.modelUsage,
    });
    active.phase = result.terminalFailure ? "paused" : "running";
    await persist(runtime, active);
    return;
  }
  if (
    !message.id ||
    !result.terminalFailure ||
    !["resource_limit", "planner_timeout"].includes(
      result.terminalFailure.kind,
    ) ||
    (await resolveStage1SenderRole(runtime, message)) !== "OWNER"
  )
    return;
  const budget =
    maxPromptTokens ?? mergeChainingLoopConfig({}).maxTrajectoryPromptTokens;
  if (!Number.isFinite(budget) || budget <= 0) return;
  const taskId = stringToUuid(
    `${runtime.agentId}:planner-continuation:${message.id}`,
  );
  if (await runtime.getTask(taskId)) return;
  const checkpoint: PlannerContinuation = {
    version: 1,
    taskId,
    agentId: runtime.agentId,
    original: clone(message),
    state: clone({
      trajectory: result.trajectory,
      modelUsage: result.modelUsage ?? {
        promptTokens: 0,
        completionTokens: 0,
        modelCalls: 0,
      },
    }),
    authorizedTotalPromptBudget: budget,
    additionalPromptBudget: budget,
    attempt: 0,
    phase: "paused",
  };
  await runtime.createTask({
    id: taskId,
    name: PLANNER_CONTINUATION_TASK,
    description: "Resume unfinished planner work from preserved receipts",
    agentId: runtime.agentId,
    entityId: message.entityId,
    roomId: message.roomId,
    tags: ["planner-continuation"],
    metadata: { paused: true, plannerContinuation: checkpoint },
  });
  await persist(runtime, checkpoint);
}

export async function checkpointActivePlanner(
  runtime: IAgentRuntime,
  message: Memory,
  state: PlannerResumeState,
  phase: "before_tool" | "after_tool",
): Promise<void> {
  const active = getActivePlannerContinuation(runtime, message);
  if (!active) return;
  active.state = clone(state);
  active.phase = phase === "before_tool" ? "executing" : "running";
  await persist(runtime, active);
}

/** Registers once per live runtime; task rows survive service/process recreation. */
export async function registerPlannerContinuationWorker(
  runtime: IAgentRuntime,
): Promise<void> {
  if (runtime.getTaskWorker(PLANNER_CONTINUATION_TASK))
    return recoverPlannerContinuations(runtime);
  runtime.registerTaskWorker({
    name: PLANNER_CONTINUATION_TASK,
    canExecute: async (current, message) =>
      (await resolveStage1SenderRole(current, message)) === "OWNER",
    shouldRun: async (current, task) =>
      readCheckpoint(current, task).phase === "queued" &&
      current.roomHandlerQueue.pendingTotal() === 0,
    execute: async (current, options, task) => {
      if (!task.id) invalid("Continuation task id missing");
      const latest = await current.getTask(task.id);
      if (!latest) return { preserveTask: true };
      const checkpoint = readCheckpoint(current, latest);
      if (options.option === CANCEL_PLANNER_OPTION) {
        checkpoint.phase = "cancelled";
        await persist(current, checkpoint);
        controllers
          .get(current)
          ?.get(task.id)
          ?.abort(new Error("Planner continuation cancelled"));
        return { preserveTask: true };
      }
      if (
        (await resolveStage1SenderRole(current, checkpoint.original)) !==
        "OWNER"
      ) {
        checkpoint.phase = "blocked";
        await persist(current, checkpoint);
        return { preserveTask: true };
      }
      if (options.option === RESUME_PLANNER_OPTION) {
        if (checkpoint.phase !== "paused") return { preserveTask: true };
        checkpoint.authorizedTotalPromptBudget +=
          checkpoint.additionalPromptBudget;
        checkpoint.phase = "queued";
        await persist(current, checkpoint);
        return { preserveTask: true };
      }
      if (checkpoint.phase !== "queued") return { preserveTask: true };
      let lock = running.get(current);
      if (!lock) {
        lock = new Set();
        running.set(current, lock);
      }
      if (lock.has(task.id)) return { preserveTask: true };
      lock.add(task.id);
      let taskControllers = controllers.get(current);
      if (!taskControllers) {
        taskControllers = new Map();
        controllers.set(current, taskControllers);
      }
      const controller = new AbortController();
      taskControllers.set(task.id, controller);
      checkpoint.phase = "running";
      checkpoint.attempt++;
      const message = clone(checkpoint.original);
      message.id = stringToUuid(`${task.id}:resume:${checkpoint.attempt}`);
      message.createdAt = Date.now();
      let active = bindings.get(current);
      if (!active) {
        active = new Map();
        bindings.set(current, active);
      }
      active.set(message.id, checkpoint);
      try {
        if (
          !(await persist(current, checkpoint, {
            phase: "queued",
            attempt: checkpoint.attempt - 1,
          }))
        )
          return { preserveTask: true };
        if (!current.messageService) invalid("Message service unavailable");
        const outputs: Content[] = [];
        const result = await current.messageService.handleMessage(
          current,
          message,
          async (content) => {
            outputs.push(clone(content));
            return [];
          },
          { abortSignal: controller.signal },
        );
        const fresh = await current.getTask(task.id);
        if (!fresh || readCheckpoint(current, fresh).phase === "cancelled")
          return { preserveTask: true };
        if (readCheckpoint(current, fresh).phase === "paused")
          return { preserveTask: true };
        if (
          result.outcome?.status === "failed" ||
          result.outcome?.status === "cancelled" ||
          result.mode === "blocked"
        ) {
          checkpoint.phase = "blocked";
          await persist(current, checkpoint);
          return { preserveTask: true };
        }
        // Only send outputs which passed the message service's outbound guards.
        // A returned responseContent alone is not a delivery authorization.
        if (outputs.length === 0) {
          checkpoint.phase = "blocked";
          await persist(current, checkpoint);
          return { preserveTask: true };
        }
        const room = await current.getRoom(message.roomId);
        if (!room?.source) invalid("Continuation delivery room unavailable");
        checkpoint.deliveries = outputs.map((content, index) => ({
          id: stringToUuid(
            `${task.id}:delivery:${checkpoint.attempt}:${index}`,
          ),
          content,
          acknowledged: false,
        }));
        checkpoint.phase = "delivery_pending";
        await persist(current, checkpoint);
        for (const delivery of checkpoint.deliveries) {
          const currentTask = await current.getTask(task.id);
          if (
            !currentTask ||
            readCheckpoint(current, currentTask).phase === "cancelled"
          )
            return { preserveTask: true };
          if (
            (await resolveStage1SenderRole(current, checkpoint.original)) !==
            "OWNER"
          )
            invalid("Continuation authorization was revoked before delivery");
          checkpoint.delivery = delivery;
          await persist(current, checkpoint);
          const sent = await current.sendMessageToTarget(
            {
              source: room.source,
              roomId: room.id,
              channelId: room.channelId,
              serverId: room.serverId,
              ...(typeof room.metadata?.accountId === "string"
                ? { accountId: room.metadata.accountId }
                : {}),
              entityId: message.entityId,
            },
            { ...delivery.content, id: delivery.id },
          );
          const acknowledged =
            sent &&
            (("kind" in sent &&
              (sent.kind === "delivered" ||
                (sent.kind === "duplicate" &&
                  sent.priorDelivery === "delivered"))) ||
              ("id" in sent && Boolean(sent.id)));
          if (!acknowledged) return { preserveTask: true };
          delivery.acknowledged = true;
          await persist(current, checkpoint);
        }
        checkpoint.phase = "delivered";
        await persist(current, checkpoint);
      } catch (error) {
        // Execution/delivery may have committed. Park ambiguous checkpoints;
        // never retry them automatically or erase the last durable evidence.
        current.reportError("PlannerContinuation.execute", error, {
          taskId: task.id,
        });
        try {
          const latest = await current.getTask(task.id);
          if (latest) {
            const durable = readCheckpoint(current, latest);
            durable.failure = { code: "PLANNER_CONTINUATION_EXECUTION_FAILED" };
            await persist(current, durable);
          }
        } catch (persistenceError) {
          // Preserve the last durable boundary even when diagnostic persistence fails.
          current.reportError(
            "PlannerContinuation.persistFailure",
            persistenceError,
            {
              taskId: task.id,
            },
          );
        }
        // TaskService deletes failed non-repeat tasks when a worker throws.
        // Report the failure above, but retain this parked task and its receipts.
        return { preserveTask: true };
      } finally {
        active.delete(message.id);
        lock.delete(task.id);
        taskControllers.delete(task.id);
      }
      return { preserveTask: true };
    },
  });
  // A fresh registration marks a new worker lifetime; scan again.
  recovered.delete(runtime);
  await recoverPlannerContinuations(runtime);
}

/**
 * Once per live runtime, park checkpoints left by a previous process. Only
 * settled snapshots are resumable; executing and unacknowledged delivery
 * checkpoints stay parked (never replayed) with a cancel choice. A failed scan
 * is reported and retried on the next worker registration.
 */
async function recoverPlannerContinuations(
  runtime: IAgentRuntime,
): Promise<void> {
  let pending = recovered.get(runtime);
  if (!pending) {
    pending = (async () => {
      for (const task of await runtime.getTasks({
        agentIds: [runtime.agentId],
        tags: ["planner-continuation"],
      })) {
        const checkpoint = readCheckpoint(runtime, task);
        if (running.get(runtime)?.has(checkpoint.taskId)) continue;
        if (checkpoint.phase === "running") {
          checkpoint.phase = "paused";
          await persist(runtime, checkpoint);
        } else if (
          (checkpoint.phase === "executing" ||
            checkpoint.phase === "delivery_pending") &&
          checkpoint.failure === undefined
        ) {
          checkpoint.failure = { code: "PLANNER_CONTINUATION_INTERRUPTED" };
          await persist(runtime, checkpoint);
        }
      }
    })();
    recovered.set(runtime, pending);
  }
  try {
    await pending;
  } catch (error) {
    if (recovered.get(runtime) === pending) recovered.delete(runtime);
    runtime.reportError("PlannerContinuation.recoveryFailure", error, {
      agentId: runtime.agentId,
    });
  }
}
