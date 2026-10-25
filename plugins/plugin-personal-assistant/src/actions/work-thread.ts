/**
 * WORK_THREAD action — lifecycle control for long-running assistant work
 * threads (start, append operations, status, complete). Threads are persisted
 * through the WorkThreadStore and can carry a ScheduledTaskTrigger so the
 * runner resumes them; a semaphore serializes concurrent field-op mutations.
 */
import crypto from "node:crypto";
import type {
  Action,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { ElizaError, getActionReplyOwner, Semaphore } from "@elizaos/core";
import {
  type ScheduledTask,
  type ScheduledTaskTrigger,
  ScheduledTaskValidationError,
} from "@elizaos/plugin-scheduling";
import { hasLifeOpsAccess } from "../lifeops/access.js";
import { getScheduledTaskRunner } from "../lifeops/scheduled-task/service.js";
import { OptimisticLockError, withOptimisticRetry } from "../lifeops/sql.js";
import {
  createWorkThreadStore,
  type ThreadSourceRef,
  type UpdateWorkThreadInput,
  type WorkThread,
  type WorkThreadStatus,
} from "../lifeops/work-threads/index.js";
import {
  withWorkThreadOperationLocks,
  workThreadLockKey,
} from "../lifeops/work-threads/operation-lock.js";

/**
 * Build a stable idempotency key for a merge attempt. Same (turn, target,
 * sorted sources) → same key, so retries during one turn deduplicate.
 */
function buildMergeRequestId(args: {
  turnId: string;
  targetId: string;
  sourceIds: string[];
}): string {
  const sorted = [...args.sourceIds].sort();
  const seed = `${args.turnId}|${args.targetId}|${sorted.join(",")}`;
  return crypto.createHash("sha1").update(seed).digest("hex").slice(0, 24);
}

const THREAD_OPERATION_TYPES = [
  "create",
  "steer",
  "stop",
  "mark_waiting",
  "mark_completed",
  "merge",
  "attach_source",
  "schedule_followup",
] as const;
type ThreadOperationType = (typeof THREAD_OPERATION_TYPES)[number];

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
      keys.add(workThreadLockKey(operation.workThreadId.trim()));
    }
    for (const sourceWorkThreadId of normalizeSourceWorkThreadIds(
      operation.sourceWorkThreadIds,
    )) {
      keys.add(workThreadLockKey(sourceWorkThreadId));
    }
  }
  return [...keys].sort();
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

function hasCurrentMutableRef(
  thread: WorkThread,
  roomId: string | null,
): boolean {
  if (!roomId) return false;
  return [thread.primarySourceRef, ...thread.sourceRefs].some(
    (ref) => ref.roomId === roomId && ref.canMutate !== false,
  );
}

// A source ref is accepted only for the current channel, and only as a
// mutable ref. Each refusal names the field the planner must change.
function sourceRefRefusal(
  ref: ThreadSourceRef,
  roomId: string | null,
):
  | "SOURCE_REF_NOT_CURRENT_CHANNEL"
  | "SOURCE_REF_READ_ONLY_NOT_SUPPORTED"
  | null {
  if (!roomId || ref.roomId !== roomId) return "SOURCE_REF_NOT_CURRENT_CHANNEL";
  if (ref.canMutate === false) return "SOURCE_REF_READ_ONLY_NOT_SUPPORTED";
  return null;
}

function operationType(value: unknown): ThreadOperationType | null {
  return THREAD_OPERATION_TYPES.find((type) => type === value) ?? null;
}

function statusForOperation(
  type: ThreadOperationType,
): WorkThreadStatus | null {
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
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ];
}

function _mergedMetadata(
  current: WorkThread,
  sourceWorkThreadIds: string[],
): Record<string, unknown> {
  const existing = current.metadata?.mergedFromWorkThreadIds;
  const existingIds = Array.isArray(existing)
    ? existing.filter((item): item is string => typeof item === "string")
    : [];
  return {
    mergedFromWorkThreadIds: [
      ...new Set([...existingIds, ...sourceWorkThreadIds]),
    ],
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
  const roomId =
    typeof message.roomId === "string" ? message.roomId : undefined;
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
  name: "WORK_THREAD",
  // Lifecycle operations must not invent unused IDs, source grants, or triggers.
  toolSchemaStrict: false,
  similes: [
    "THREAD_CONTROL",
    "STEER_THREAD",
    "STOP_THREAD",
    "CREATE_THREAD",
    "SCHEDULE_THREAD_FOLLOWUP",
    // PRD action-catalog alias. The PRD's "group handoff" maps to thread
    // lifecycle ops (create + attach_source) on WORK_THREAD.
    "MESSAGE_CREATE_GROUP_HANDOFF",
  ],
  description:
    "Owner work-thread lifecycle: create, steer, stop, wait, complete, merge, attach source refs, schedule follow-up. Use only thread lifecycle/routing; domain work -> task/messaging/workflow actions.",
  descriptionCompressed:
    "work-thread lifecycle: create|steer|stop|waiting|completed|merge|attach_source|followup",
  contexts: ["tasks", "messaging", "automation"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  validate: validateThreadAction,
  parameters: [
    {
      name: "operations",
      description:
        "Thread lifecycle operations as a JSON array of objects, never a JSON-encoded string. Each object uses the exact type enum below.",
      required: true,
      schema: {
        type: "array" as const,
        items: {
          type: "object" as const,
          additionalProperties: true,
          properties: {
            type: {
              type: "string" as const,
              enum: [...THREAD_OPERATION_TYPES],
              description:
                "Exact lifecycle operation. create records a thread; it does not start domain work.",
            },
            workThreadId: {
              type: "string" as const,
              description: "Existing target ID; required except for create.",
            },
            sourceWorkThreadIds: {
              type: "array" as const,
              items: { type: "string" as const },
              description: "merge: IDs to absorb into workThreadId.",
            },
            title: {
              type: "string" as const,
              description: "create: exact requested thread title.",
            },
            summary: {
              type: "string" as const,
              description: "create or steer: description of the work.",
            },
            instruction: {
              type: "string" as const,
              description:
                "Plan for create; required for steer and schedule_followup.",
            },
            reason: { type: "string" as const },
            sourceRef: {
              type: "object" as const,
              additionalProperties: true,
              description:
                "create or attach_source: omit to use the current channel. Only the current channel is accepted: roomId must equal the room of this message. A reference to another channel fails with SOURCE_REF_NOT_CURRENT_CHANNEL. canMutate false fails with SOURCE_REF_READ_ONLY_NOT_SUPPORTED.",
              properties: {
                connector: { type: "string" as const },
                channelName: { type: "string" as const },
                channelKind: { type: "string" as const },
                roomId: { type: "string" as const },
                externalThreadId: { type: "string" as const },
                accountId: { type: "string" as const },
                canRead: { type: "boolean" as const },
                canMutate: { type: "boolean" as const },
              },
              required: ["connector", "roomId"],
            },
            trigger: {
              type: "object" as const,
              additionalProperties: true,
              description:
                "schedule_followup: ScheduledTaskTrigger. once needs atIso; cron needs expression/tz; interval needs everyMinutes and optional from/until; relative_to_anchor needs anchorKey/offsetMinutes; during_window needs windowKey; event needs eventKind and optional filter; manual needs only kind; after_task needs taskId/outcome.",
            },
          },
          required: ["type"],
        },
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
      withWorkThreadOperationLocks(
        lockKeysForOperations(operations, message),
        async () => {
          const store = createWorkThreadStore(runtime);
          const roomId =
            typeof message.roomId === "string" ? message.roomId : null;
          const updateMutableThread = (
            workThreadId: string,
            input: UpdateWorkThreadInput,
          ) =>
            withOptimisticRetry(async () => {
              const current = await store.get(workThreadId);
              if (!current)
                throw new ElizaError("Work thread no longer exists", {
                  code: "WORK_THREAD_NOT_FOUND",
                });
              if (isTerminalThreadStatus(current.status))
                throw new ElizaError("Work thread is no longer active", {
                  code: "WORK_THREAD_NOT_ACTIVE",
                });
              if (!hasCurrentMutableRef(current, roomId))
                throw new ElizaError(
                  "Work thread is no longer mutable from this channel",
                  { code: "WORK_THREAD_READ_ONLY" },
                );
              const updated = await store.update(workThreadId, {
                ...input,
                expectedVersion: current.version,
              });
              if (!updated)
                throw new ElizaError("Work thread no longer exists", {
                  code: "WORK_THREAD_NOT_FOUND",
                });
              return updated;
            });
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
              const sourceRefError = operation.sourceRef
                ? sourceRefRefusal(operation.sourceRef, roomId)
                : null;
              if (sourceRefError) {
                results.push({ success: false, type, error: sourceRefError });
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
                  typeof message.entityId === "string"
                    ? message.entityId
                    : null,
                title:
                  operation.title ?? operation.instruction ?? "Active thread",
                summary:
                  operation.summary ?? operation.instruction ?? "Active thread",
                currentPlanSummary: operation.instruction ?? null,
                primarySourceRef: initialSourceRef,
                sourceRefs: [initialSourceRef],
                participantEntityIds:
                  typeof message.entityId === "string"
                    ? [message.entityId]
                    : [],
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
              await updateMutableThread(workThreadId, {
                currentPlanSummary: instruction,
                summary: operation.summary,
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

              // Pre-validate (mutability + terminal status) against the snapshot
              // we just read. Atomic write happens in store.merge() — if a
              // version mismatch occurs there, we retry under withOptimisticRetry.
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

              // Derive an idempotency key so re-execution of the same merge
              // (e.g., retry after transient error) is a no-op.
              const mergeRequestId = buildMergeRequestId({
                turnId: typeof message.id === "string" ? message.id : "unknown",
                targetId: workThreadId,
                sourceIds: sourceWorkThreadIds,
              });

              try {
                const result = await withOptimisticRetry(() =>
                  store.merge({
                    targetWorkThreadId: workThreadId,
                    sourceWorkThreadIds,
                    mergeRequestId,
                    patch: {
                      summary: operation.summary,
                      instruction: operation.instruction ?? null,
                      lastMessageMemoryId:
                        typeof message.id === "string" ? message.id : null,
                      participantsToAdd:
                        typeof message.entityId === "string"
                          ? [message.entityId]
                          : [],
                    },
                    reason: operation.reason,
                  }),
                );

                results.push({
                  success: true,
                  type,
                  workThreadId,
                  sourceWorkThreadIds: result.sources.map((s) => s.id),
                  freshlyMerged: result.freshlyMerged,
                });
              } catch (err) {
                const errorCode =
                  err instanceof OptimisticLockError
                    ? "MERGE_CONFLICT"
                    : err instanceof Error && (err as { code?: unknown }).code
                      ? String((err as { code?: unknown }).code)
                      : "MERGE_FAILED";
                const errorMessage =
                  err instanceof Error ? err.message : String(err);
                results.push({
                  success: false,
                  type,
                  workThreadId,
                  sourceWorkThreadIds,
                  error: errorCode,
                  message: errorMessage,
                });
              }
              continue;
            }

            if (type === "attach_source") {
              const ref = operation.sourceRef ?? sourceRef;
              const sourceRefError = sourceRefRefusal(ref, roomId);
              if (sourceRefError) {
                results.push({
                  success: false,
                  type,
                  workThreadId,
                  error: sourceRefError,
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
              const runner = getScheduledTaskRunner(runtime, {
                agentId: runtime.agentId,
              });
              let task: ScheduledTask;
              try {
                task = await runner.schedule({
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
              } catch (err) {
                // A rejected trigger fails this operation only; earlier
                // operations in the batch are already stored and reported.
                if (!(err instanceof ScheduledTaskValidationError)) {
                  throw err;
                }
                results.push({
                  success: false,
                  type,
                  workThreadId,
                  error: "INVALID_TRIGGER",
                  message: err.message,
                  issues: err.issues,
                });
                continue;
              }
              // The link is taken under the thread lock, so this snapshot
              // names the follow-up this one replaces.
              const supersededTaskId =
                current.currentScheduledTaskId &&
                current.currentScheduledTaskId !== task.taskId
                  ? current.currentScheduledTaskId
                  : null;
              try {
                // Retry the link only: rescheduling here would create another task.
                await updateMutableThread(workThreadId, {
                  currentScheduledTaskId: task.taskId,
                  eventType: "followup_scheduled",
                  reason: operation.reason,
                  detail: {
                    taskId: task.taskId,
                    ...(supersededTaskId ? { supersededTaskId } : {}),
                  },
                });
              } catch (error) {
                try {
                  // An event write can fail after the link committed. Keep that
                  // recorded task; otherwise remove the unlinked durable effect.
                  const persisted = await store.get(workThreadId);
                  if (
                    persisted?.currentScheduledTaskId !== task.taskId &&
                    !(await runner.remove?.(task.taskId))
                  ) {
                    throw new ElizaError(
                      "Follow-up removal could not be confirmed",
                      { code: "WORK_THREAD_FOLLOWUP_REMOVE_UNCONFIRMED" },
                    );
                  }
                } catch (cleanupError) {
                  throw new ElizaError(
                    "Follow-up link failed and its task requires reconciliation",
                    {
                      code: "WORK_THREAD_FOLLOWUP_RECONCILIATION_REQUIRED",
                      cause: new AggregateError([error, cleanupError]),
                      context: { workThreadId, taskId: task.taskId },
                    },
                  );
                }
                throw error;
              }
              // Link first, then drop the follow-up it replaces: a crash in
              // between leaves the old follow-up live, never none. The link
              // is committed; a removal that cannot be confirmed names the
              // task that still needs reconciliation.
              if (supersededTaskId) {
                try {
                  if (typeof runner.remove !== "function")
                    throw new ElizaError("Follow-up removal is unavailable", {
                      code: "WORK_THREAD_FOLLOWUP_REMOVE_UNCONFIRMED",
                    });
                  await runner.remove(supersededTaskId);
                } catch (cleanupError) {
                  throw new ElizaError(
                    "Replaced follow-up is still scheduled and requires reconciliation",
                    {
                      code: "WORK_THREAD_FOLLOWUP_RECONCILIATION_REQUIRED",
                      cause: cleanupError,
                      context: {
                        workThreadId,
                        taskId: supersededTaskId,
                        currentTaskId: task.taskId,
                      },
                    },
                  );
                }
              }
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
              // A stopped or completed thread has no further work: its
              // pending follow-up must not fire. Waiting keeps the nudge.
              // The thread commits first (the owner's intent is durable, and
              // the scheduler tick dismisses a follow-up whose thread ended
              // before it fires); the task row is then removed, and a
              // removal that cannot be confirmed names the task that still
              // needs reconciliation.
              const releasedTaskId =
                isTerminalThreadStatus(status) && current.currentScheduledTaskId
                  ? current.currentScheduledTaskId
                  : null;
              await updateMutableThread(workThreadId, {
                status,
                ...(releasedTaskId
                  ? {
                      currentScheduledTaskId: null,
                      detail: { removedTaskId: releasedTaskId },
                    }
                  : {}),
                eventType:
                  type === "stop"
                    ? "stopped"
                    : type === "mark_waiting"
                      ? "waiting"
                      : "completed",
                reason: operation.reason,
              });
              if (releasedTaskId) {
                try {
                  const runner = getScheduledTaskRunner(runtime, {
                    agentId: runtime.agentId,
                  });
                  if (typeof runner.remove !== "function")
                    throw new ElizaError("Follow-up removal is unavailable", {
                      code: "WORK_THREAD_FOLLOWUP_REMOVE_UNCONFIRMED",
                    });
                  await runner.remove(releasedTaskId);
                } catch (cleanupError) {
                  throw new ElizaError(
                    "Thread ended but its follow-up is still scheduled and requires reconciliation",
                    {
                      code: "WORK_THREAD_FOLLOWUP_RECONCILIATION_REQUIRED",
                      cause: cleanupError,
                      context: { workThreadId, taskId: releasedTaskId, status },
                    },
                  );
                }
              }
              results.push({ success: true, type, workThreadId, status });
            }
          }

          const ok = results.some((result) => result.success === true);
          const text = ok
            ? `Applied ${results.filter((result) => result.success === true).length} thread operation${results.filter((result) => result.success === true).length === 1 ? "" : "s"}.`
            : "No thread operations were applied.";
          // The owning planner receives the complete operation results and
          // writes the final reply. A visible callback here would trigger a
          // separate voice-rewrite model before that same final synthesis.
          if (getActionReplyOwner(message.id) === "planner") {
            return {
              success: ok,
              text,
              data: { operations: results },
              transcriptVisibility: "internal",
              modelReplyRequired: true,
              turnComplete: false,
            };
          }
          await callback?.({
            text,
            source: "action",
            action: "WORK_THREAD",
          });
          return { success: ok, text, data: { operations: results } };
        },
      ),
    );
  },
};
