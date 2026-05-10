import type {
  Action,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { Semaphore } from "@elizaos/core";
import { hasLifeOpsAccess } from "../lifeops/access.js";
import { createRuntimeScheduledTaskRunner } from "../lifeops/scheduled-task/runtime-wiring.js";
import type { ScheduledTaskTrigger } from "../lifeops/scheduled-task/types.js";
import {
  createWorkThreadStore,
  type ThreadSourceRef,
  type WorkThread,
  type WorkThreadStatus,
} from "../lifeops/work-threads/index.js";

type ThreadOperationType =
  | "create"
  | "steer"
  | "stop"
  | "mark_waiting"
  | "mark_completed"
  | "merge"
  | "attach_source"
  | "schedule_followup";

interface ThreadOperation {
  type?: ThreadOperationType;
  workThreadId?: string;
  sourceWorkThreadIds?: string[];
  title?: string;
  summary?: string;
  sourceRef?: ThreadSourceRef;
  instruction?: string;
  reason?: string;
  trigger?: ScheduledTaskTrigger;
}

interface WorkThreadParams {
  operations?: ThreadOperation[];
}

const MAX_ACTIVE_WORK_THREADS = 30;
const MAX_CONCURRENT_THREAD_CONTROL_OPERATIONS = 4;
const workThreadOperationSemaphore = new Semaphore(
  MAX_CONCURRENT_THREAD_CONTROL_OPERATIONS,
);
const workThreadOperationQueues = new Map<string, Promise<void>>();

function lockKeysForOperations(
  operations: readonly ThreadOperation[],
  message: Memory,
): string[] {
  const keys = new Set<string>();
  if (typeof message.roomId === "string" && message.roomId.length > 0) {
    keys.add(`room:${message.roomId}`);
  }
  for (const operation of operations) {
    if (
      typeof operation.workThreadId === "string" &&
      operation.workThreadId.trim().length > 0
    ) {
      keys.add(`thread:${operation.workThreadId.trim()}`);
    }
    for (const sourceWorkThreadId of normalizeSourceWorkThreadIds(
      operation.sourceWorkThreadIds,
    )) {
      keys.add(`thread:${sourceWorkThreadId}`);
    }
  }
  return [...keys].sort();
}

async function withThreadOperationLocks<T>(
  keys: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  if (keys.length === 0) {
    return operation();
  }
  const releases: Array<() => void> = [];
  for (const key of keys) {
    const previous = workThreadOperationQueues.get(key) ?? Promise.resolve();
    let releaseCurrent = () => {};
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.then(() => current);
    workThreadOperationQueues.set(key, tail);
    await previous;
    releases.push(() => {
      releaseCurrent();
      if (workThreadOperationQueues.get(key) === tail) {
        workThreadOperationQueues.delete(key);
      }
    });
  }
  try {
    return await operation();
  } finally {
    for (const release of releases.reverse()) {
      release();
    }
  }
}

async function withThreadOperationConcurrency<T>(
  operation: () => Promise<T>,
): Promise<T> {
  await workThreadOperationSemaphore.acquire();
  try {
    return await operation();
  } finally {
    workThreadOperationSemaphore.release();
  }
}

function getParams(options: HandlerOptions | undefined): WorkThreadParams {
  const raw = options?.parameters;
  return raw && typeof raw === "object" ? (raw as WorkThreadParams) : {};
}

function metadataRecord(message: Memory): Record<string, unknown> {
  return message.metadata && typeof message.metadata === "object"
    ? (message.metadata as Record<string, unknown>)
    : {};
}

function nestedRecord(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = source[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function sourceRefFromMessage(message: Memory): ThreadSourceRef {
  const metadata = metadataRecord(message);
  const base = nestedRecord(metadata, "base");
  const delivery = nestedRecord(metadata, "delivery");
  const origin = nestedRecord(metadata, "origin");
  const thread = nestedRecord(metadata, "thread");
  const group = nestedRecord(metadata, "group");
  const connector =
    stringField(metadata.provider) ??
    stringField(base.source) ??
    stringField(message.content.source) ??
    "eliza";
  const externalThreadId =
    stringField(delivery.threadId) ??
    stringField(origin.threadId) ??
    stringField(thread.id);
  return {
    connector,
    channelName:
      stringField(group.name) ??
      stringField(origin.label) ??
      stringField(delivery.channel),
    channelKind:
      stringField(metadata.chatType) ??
      stringField(origin.chatType) ??
      stringField(message.content.channelType),
    roomId: stringField(message.roomId),
    externalThreadId,
    accountId:
      stringField(metadata.accountId) ??
      stringField(delivery.accountId) ??
      stringField(origin.accountId),
    canRead: true,
    canMutate: true,
  };
}

function looksLikeThreadLifecycleIntent(message: Memory): boolean {
  const text = String(message.content.text ?? "").toLowerCase();
  return /\b(thread|conversation|workstream|follow-?up|keep working|continue this|stop this|pause this|merge (?:these|this)|combine (?:these|this)|mark (?:this )?(?:done|complete)|schedule (?:a )?follow-?up)\b/.test(
    text,
  );
}

function hasCurrentMutableRef(thread: WorkThread, roomId: string | null): boolean {
  if (!roomId) return false;
  return [thread.primarySourceRef, ...thread.sourceRefs].some(
    (ref) => ref.roomId === roomId && ref.canMutate !== false,
  );
}

function isCurrentChannelMutableSourceRef(
  ref: ThreadSourceRef,
  roomId: string | null,
): boolean {
  return !!roomId && ref.roomId === roomId && ref.canMutate !== false;
}

function operationType(value: unknown): ThreadOperationType | null {
  if (
    value === "create" ||
    value === "steer" ||
    value === "stop" ||
    value === "mark_waiting" ||
    value === "mark_completed" ||
    value === "merge" ||
    value === "attach_source" ||
    value === "schedule_followup"
  ) {
    return value;
  }
  return null;
}

function statusForOperation(type: ThreadOperationType): WorkThreadStatus | null {
  if (type === "stop") return "stopped";
  if (type === "mark_waiting") return "waiting";
  if (type === "mark_completed") return "completed";
  return null;
}

function isTerminalThreadStatus(status: WorkThreadStatus): boolean {
  return status === "stopped" || status === "completed";
}

function normalizeSourceWorkThreadIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value.filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ];
}

function mergedMetadata(
  current: WorkThread,
  sourceWorkThreadIds: string[],
): Record<string, unknown> {
  const existing = current.metadata?.mergedFromWorkThreadIds;
  const existingIds = Array.isArray(existing)
    ? existing.filter((item): item is string => typeof item === "string")
    : [];
  return {
    mergedFromWorkThreadIds: [...new Set([...existingIds, ...sourceWorkThreadIds])],
  };
}

async function validateThreadAction(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<boolean> {
  if (!(await hasLifeOpsAccess(runtime, message))) {
    return false;
  }
  if (looksLikeThreadLifecycleIntent(message)) {
    return true;
  }
  const roomId = typeof message.roomId === "string" ? message.roomId : undefined;
  if (!roomId) {
    return false;
  }
  try {
    const active = await createWorkThreadStore(runtime).list({
      statuses: ["active", "waiting", "paused"],
      roomId,
      limit: 1,
    });
    return active.length > 0;
  } catch {
    return false;
  }
}

export const workThreadAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: "LIFEOPS_THREAD_CONTROL",
  similes: [
    "lifeops_thread_control",
    "WORK_THREAD",
    "THREAD_CONTROL",
    "STEER_THREAD",
    "STOP_THREAD",
    "CREATE_THREAD",
    "SCHEDULE_THREAD_FOLLOWUP",
  ],
  description:
    "Create, steer, stop, wait, complete, merge, attach source refs to, or schedule follow-up work for LifeOps work threads. Use only for thread lifecycle/routing; domain work stays on existing task/messaging/workflow actions.",
  descriptionCompressed:
    "LifeOps work-thread lifecycle: create|steer|stop|mark_waiting|mark_completed|merge|attach_source|schedule_followup",
  contexts: ["tasks", "messaging", "automation"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  validate: validateThreadAction,
  parameters: [
    {
      name: "operations",
      description:
        "Array of thread lifecycle operations. Each item has type, optional workThreadId, sourceWorkThreadIds, instruction, reason, title, summary, sourceRef, and trigger for schedule_followup.",
      required: true,
      schema: {
        type: "array" as const,
        items: { type: "object" as const, additionalProperties: true },
      },
    },
  ],
  examples: [],
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
    callback,
  ): Promise<ActionResult> => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      const text = "Thread control is restricted to the owner.";
      await callback?.({ text });
      return { success: false, text, data: { error: "PERMISSION_DENIED" } };
    }
    const params = getParams(options);
    const operations = Array.isArray(params.operations)
      ? params.operations
      : [];
    if (operations.length === 0) {
      return {
        success: false,
        text: "I need at least one thread operation.",
        data: { error: "MISSING_OPERATIONS" },
      };
    }

    return withThreadOperationConcurrency(() =>
      withThreadOperationLocks(lockKeysForOperations(operations, message), async () => {
        const store = createWorkThreadStore(runtime);
        const roomId = typeof message.roomId === "string" ? message.roomId : null;
        const sourceRef = sourceRefFromMessage(message);
        const results: Array<Record<string, unknown>> = [];

        for (const operation of operations) {
          const type = operationType(operation.type);
          if (!type) {
            results.push({ success: false, error: "INVALID_OPERATION" });
            continue;
          }
          if (type === "create") {
            const initialSourceRef = operation.sourceRef ?? sourceRef;
            if (
              operation.sourceRef &&
              !isCurrentChannelMutableSourceRef(operation.sourceRef, roomId)
            ) {
              results.push({
                success: false,
                type,
                error: "SOURCE_REF_NOT_CURRENT_CHANNEL",
              });
              continue;
            }
            const activeThreads = await store.list({
              statuses: ["active", "waiting", "paused"],
              limit: MAX_ACTIVE_WORK_THREADS,
            });
            if (activeThreads.length >= MAX_ACTIVE_WORK_THREADS) {
              results.push({
                success: false,
                type,
                error: "THREAD_POOL_FULL",
                maxActiveThreads: MAX_ACTIVE_WORK_THREADS,
              });
              continue;
            }
            const created = await store.create({
              ownerEntityId:
                typeof message.entityId === "string" ? message.entityId : null,
              title:
                operation.title ?? operation.instruction ?? "Active thread",
              summary:
                operation.summary ?? operation.instruction ?? "Active thread",
              currentPlanSummary: operation.instruction ?? null,
              primarySourceRef: initialSourceRef,
              sourceRefs: [initialSourceRef],
              participantEntityIds:
                typeof message.entityId === "string" ? [message.entityId] : [],
              lastMessageMemoryId:
                typeof message.id === "string" ? message.id : null,
              metadata: { createdFrom: "lifeops_thread_control" },
            });
            results.push({ success: true, type, workThreadId: created.id });
            continue;
          }

          const workThreadId = operation.workThreadId?.trim();
          if (!workThreadId) {
            results.push({
              success: false,
              type,
              error: "MISSING_WORK_THREAD_ID",
            });
            continue;
          }
          const current = await store.get(workThreadId);
          if (!current) {
            results.push({
              success: false,
              type,
              workThreadId,
              error: "NOT_FOUND",
            });
            continue;
          }
          const canMutate =
            type === "attach_source" || hasCurrentMutableRef(current, roomId);
          if (!canMutate) {
            results.push({
              success: false,
              type,
              workThreadId,
              error: "CROSS_CHANNEL_READ_ONLY",
            });
            continue;
          }
          const terminalNoop =
            (type === "stop" && current.status === "stopped") ||
            (type === "mark_completed" && current.status === "completed");
          if (isTerminalThreadStatus(current.status) && !terminalNoop) {
            results.push({
              success: false,
              type,
              workThreadId,
              error: "THREAD_NOT_ACTIVE",
              status: current.status,
            });
            continue;
          }
          if (terminalNoop) {
            results.push({
              success: true,
              type,
              workThreadId,
              status: current.status,
              noop: true,
            });
            continue;
          }

          if (type === "steer") {
            const instruction = operation.instruction?.trim();
            if (!instruction) {
              results.push({
                success: false,
                type,
                workThreadId,
                error: "MISSING_INSTRUCTION",
              });
              continue;
            }
            await store.update(workThreadId, {
              currentPlanSummary: instruction,
              summary: operation.summary ?? current.summary,
              lastMessageMemoryId:
                typeof message.id === "string" ? message.id : null,
              eventType: "steered",
              reason: operation.reason,
              detail: { instruction },
            });
            results.push({ success: true, type, workThreadId });
            continue;
          }

          if (type === "merge") {
            const sourceWorkThreadIds = normalizeSourceWorkThreadIds(
              operation.sourceWorkThreadIds,
            ).filter((sourceId) => sourceId !== workThreadId);
            if (sourceWorkThreadIds.length === 0) {
              results.push({
                success: false,
                type,
                workThreadId,
                error: "MISSING_SOURCE_WORK_THREAD_IDS",
              });
              continue;
            }

            const sourceThreads: WorkThread[] = [];
            let blocked = false;
            for (const sourceWorkThreadId of sourceWorkThreadIds) {
              const sourceThread = await store.get(sourceWorkThreadId);
              if (!sourceThread) {
                results.push({
                  success: false,
                  type,
                  workThreadId,
                  sourceWorkThreadId,
                  error: "SOURCE_NOT_FOUND",
                });
                blocked = true;
                break;
              }
              if (!hasCurrentMutableRef(sourceThread, roomId)) {
                results.push({
                  success: false,
                  type,
                  workThreadId,
                  sourceWorkThreadId,
                  error: "CROSS_CHANNEL_READ_ONLY",
                });
                blocked = true;
                break;
              }
              if (isTerminalThreadStatus(sourceThread.status)) {
                results.push({
                  success: false,
                  type,
                  workThreadId,
                  sourceWorkThreadId,
                  error: "SOURCE_THREAD_NOT_ACTIVE",
                  status: sourceThread.status,
                });
                blocked = true;
                break;
              }
              sourceThreads.push(sourceThread);
            }
            if (blocked) {
              continue;
            }

            const mergedSourceRefs = [
              ...current.sourceRefs,
              ...sourceThreads.flatMap((sourceThread) => sourceThread.sourceRefs),
            ];
            const mergedParticipantEntityIds = [
              ...current.participantEntityIds,
              ...sourceThreads.flatMap(
                (sourceThread) => sourceThread.participantEntityIds,
              ),
              ...(typeof message.entityId === "string" ? [message.entityId] : []),
            ];

            await store.update(workThreadId, {
              summary: operation.summary ?? current.summary,
              currentPlanSummary:
                operation.instruction?.trim() || current.currentPlanSummary,
              sourceRefs: mergedSourceRefs,
              participantEntityIds: mergedParticipantEntityIds,
              lastMessageMemoryId:
                typeof message.id === "string" ? message.id : null,
              metadata: mergedMetadata(current, sourceWorkThreadIds),
              eventType: "merged",
              reason: operation.reason,
              detail: {
                sourceWorkThreadIds,
                instruction: operation.instruction,
              },
            });

            for (const sourceThread of sourceThreads) {
              await store.update(sourceThread.id, {
                status: "stopped",
                metadata: { mergedIntoWorkThreadId: workThreadId },
                eventType: "merged_into",
                reason: operation.reason,
                detail: { targetWorkThreadId: workThreadId },
              });
            }

            results.push({
              success: true,
              type,
              workThreadId,
              sourceWorkThreadIds,
            });
            continue;
          }

          if (type === "attach_source") {
            const ref = operation.sourceRef ?? sourceRef;
            if (!isCurrentChannelMutableSourceRef(ref, roomId)) {
              results.push({
                success: false,
                type,
                workThreadId,
                error: "SOURCE_REF_NOT_CURRENT_CHANNEL",
              });
              continue;
            }
            await store.update(workThreadId, {
              sourceRefs: [...current.sourceRefs, ref],
              eventType: "source_attached",
              reason: operation.reason,
              detail: { sourceRef: ref },
            });
            results.push({ success: true, type, workThreadId });
            continue;
          }

          if (type === "schedule_followup") {
            if (!operation.trigger || typeof operation.trigger !== "object") {
              results.push({
                success: false,
                type,
                workThreadId,
                error: "MISSING_TRIGGER",
              });
              continue;
            }
            const instruction = operation.instruction?.trim();
            if (!instruction) {
              results.push({
                success: false,
                type,
                workThreadId,
                error: "MISSING_INSTRUCTION",
              });
              continue;
            }
            const runner = createRuntimeScheduledTaskRunner({
              runtime,
              agentId: runtime.agentId,
            });
            const task = await runner.schedule({
              kind: "followup",
              promptInstructions: instruction,
              trigger: operation.trigger,
              priority: "medium",
              respectsGlobalPause: true,
              source: "user_chat",
              createdBy: runtime.agentId,
              ownerVisible: true,
              subject: { kind: "thread", id: workThreadId },
              ...(roomId
                ? {
                    output: {
                      destination: "channel",
                      target: `in_app:${roomId}`,
                    },
                  }
                : {}),
              metadata: {
                workThreadId,
                ...(roomId ? { pendingPromptRoomId: roomId } : {}),
              },
            });
            await store.update(workThreadId, {
              currentScheduledTaskId: task.taskId,
              eventType: "followup_scheduled",
              reason: operation.reason,
              detail: { taskId: task.taskId },
            });
            results.push({
              success: true,
              type,
              workThreadId,
              taskId: task.taskId,
            });
            continue;
          }

          const status = statusForOperation(type);
          if (status) {
            await store.update(workThreadId, {
              status,
              eventType:
                type === "stop"
                  ? "stopped"
                  : type === "mark_waiting"
                    ? "waiting"
                    : "completed",
              reason: operation.reason,
            });
            results.push({ success: true, type, workThreadId, status });
          }
        }

        const ok = results.some((result) => result.success === true);
        const text = ok
          ? `Applied ${results.filter((result) => result.success === true).length} thread operation${results.filter((result) => result.success === true).length === 1 ? "" : "s"}.`
          : "No thread operations were applied.";
        await callback?.({
          text,
          source: "action",
          action: "LIFEOPS_THREAD_CONTROL",
        });
        return { success: ok, text, data: { operations: results } };
      }),
    );
  },
};
