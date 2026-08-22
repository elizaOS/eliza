/**
 * Durable bridge from core MESSAGE drafts into the shared ScheduledTask spine.
 *
 * A one-shot task stores the complete draft snapshot and routes through a
 * namespaced contributed channel. At fire time the live connector recreates
 * its process-local draft state from that snapshot. The runner's atomic claim
 * permits one delivery attempt, while a pre-egress marker lets a later process
 * surface an interrupted attempt as unknown instead of retrying it.
 */

import { randomUUID } from "node:crypto";
import {
  type DeferredMessageScheduleResult,
  type DraftRecord,
  ElizaError,
  getDefaultTriageService,
  type IAgentRuntime,
  registerDeferredMessageScheduler,
} from "@elizaos/core";
import {
  type DispatchResult,
  getScheduledTaskRunner,
  registerScheduledTaskChannelDispatcher,
  type ScheduledTask,
  type ScheduledTaskChannelDispatcherContribution,
  type ScheduledTaskDispatchRecord,
  unregisterScheduledTaskChannelDispatcher,
} from "@elizaos/plugin-scheduling";
import { z } from "zod";

export const MESSAGE_DRAFT_DISPATCH_CHANNEL = "message_draft_send";
const MESSAGE_DRAFT_METADATA_KEY = "deferredMessageDraft";
const MESSAGE_DRAFT_ATTEMPT_METADATA_KEY = "deferredMessageAttempt";
const MESSAGE_DRAFT_PAYLOAD_VERSION = 1;
const MESSAGE_DRAFT_ATTEMPT_VERSION = 1;

const participantSchema = z.object({
  identifier: z.string().min(1),
  displayName: z.string().min(1).optional(),
  contactId: z.string().min(1).optional(),
});

const draftSnapshotSchema = z.object({
  draftId: z.string().min(1),
  source: z.enum([
    "gmail",
    "discord",
    "telegram",
    "twitter",
    "imessage",
    "whatsapp",
    "calendly",
    "browser_bridge",
  ]),
  inReplyToId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  to: z.array(participantSchema).min(1),
  subject: z.string().optional(),
  body: z.string().min(1),
  preview: z.string(),
  createdAtMs: z.number().finite().nonnegative(),
  sent: z.literal(false),
  worldId: z.string().min(1).optional(),
  channelId: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const deferredMessagePayloadSchema = z.object({
  version: z.literal(MESSAGE_DRAFT_PAYLOAD_VERSION),
  scheduledAtIso: z.iso.datetime({ offset: true }),
  draft: draftSnapshotSchema,
});
const successfulDispatchSchema = z.object({
  ok: z.literal(true),
  messageId: z.string().min(1),
});
const deferredMessageAttemptSchema = z.object({
  version: z.literal(MESSAGE_DRAFT_ATTEMPT_VERSION),
  bridgeInstanceId: z.string().min(1),
  startedAtIso: z.iso.datetime({ offset: true }),
  state: z.enum(["dispatching", "outcome_unknown"]),
  reconciledAtIso: z.iso.datetime({ offset: true }).optional(),
});

type DeferredMessagePayload = z.infer<typeof deferredMessagePayloadSchema>;
type DeferredMessageAttempt = z.infer<typeof deferredMessageAttemptSchema>;

function persistedDraftSnapshot(
  draft: DraftRecord,
): DeferredMessagePayload["draft"] {
  return {
    draftId: draft.draftId,
    source: draft.source,
    ...(draft.inReplyToId ? { inReplyToId: draft.inReplyToId } : {}),
    ...(draft.threadId ? { threadId: draft.threadId } : {}),
    to: draft.to.map((recipient) => ({ ...recipient })),
    ...(draft.subject !== undefined ? { subject: draft.subject } : {}),
    body: draft.body,
    preview: draft.preview,
    createdAtMs: draft.createdAtMs,
    sent: false,
    ...(draft.worldId ? { worldId: draft.worldId } : {}),
    ...(draft.channelId ? { channelId: draft.channelId } : {}),
    ...(draft.metadata ? { metadata: structuredClone(draft.metadata) } : {}),
  };
}

function readPayload(
  record:
    | Pick<ScheduledTaskDispatchRecord, "metadata">
    | Pick<ScheduledTask, "metadata">,
): DeferredMessagePayload | null {
  const candidate = record.metadata?.[MESSAGE_DRAFT_METADATA_KEY];
  const parsed = deferredMessagePayloadSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function scheduleKey(runtime: IAgentRuntime, draft: DraftRecord): string {
  return `message-draft-send:${runtime.agentId}:${draft.source}:${draft.draftId}`;
}

function onceAtMs(task: ScheduledTask): number | null {
  if (task.trigger.kind !== "once") return null;
  const parsed = Date.parse(task.trigger.atIso);
  return Number.isFinite(parsed) ? parsed : null;
}

const schedulesInFlight = new WeakMap<
  IAgentRuntime,
  Map<
    string,
    { sendAtMs: number; promise: Promise<DeferredMessageScheduleResult> }
  >
>();

function runtimeScheduleMap(
  runtime: IAgentRuntime,
): Map<
  string,
  { sendAtMs: number; promise: Promise<DeferredMessageScheduleResult> }
> {
  let map = schedulesInFlight.get(runtime);
  if (!map) {
    map = new Map();
    schedulesInFlight.set(runtime, map);
  }
  return map;
}

async function schedulePersistedDraft(args: {
  runtime: IAgentRuntime;
  draft: DraftRecord;
  sendAtMs: number;
}): Promise<DeferredMessageScheduleResult> {
  const key = scheduleKey(args.runtime, args.draft);
  const inFlight = runtimeScheduleMap(args.runtime);
  const pending = inFlight.get(key);
  if (pending) {
    if (pending.sendAtMs !== args.sendAtMs) {
      throw new ElizaError(
        "Concurrent deferred-send requests specified different delivery times.",
        {
          code: "MESSAGE_DRAFT_SCHEDULE_CONFLICT",
          context: {
            draftId: args.draft.draftId,
            existingSendAtMs: pending.sendAtMs,
            requestedSendAtMs: args.sendAtMs,
          },
          severity: "ephemeral",
        },
      );
    }
    const result = await pending.promise;
    return {
      ...result,
      commit: { ...result.commit, replayed: true },
    };
  }

  const promise = schedulePersistedDraftOnce({ ...args, key });
  inFlight.set(key, { sendAtMs: args.sendAtMs, promise });
  try {
    return await promise;
  } finally {
    if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
    if (inFlight.size === 0) schedulesInFlight.delete(args.runtime);
  }
}

async function schedulePersistedDraftOnce(args: {
  runtime: IAgentRuntime;
  draft: DraftRecord;
  sendAtMs: number;
  key: string;
}): Promise<DeferredMessageScheduleResult> {
  const runner = getScheduledTaskRunner(args.runtime, {
    agentId: String(args.runtime.agentId),
  });
  const requestedAtIso = new Date(args.sendAtMs).toISOString();
  const scheduledAtIso = new Date().toISOString();
  const task = await runner.schedule({
    kind: "output",
    promptInstructions:
      "Deliver the persisted outbound message draft through its owning connector.",
    trigger: { kind: "once", atIso: requestedAtIso },
    priority: "medium",
    // A draft belongs to one connector and cannot be safely translated into
    // another channel. An ambiguous provider outcome must never be retried.
    escalation: { steps: [] },
    output: {
      destination: "channel",
      target: MESSAGE_DRAFT_DISPATCH_CHANNEL,
      persistAs: "task_metadata",
    },
    idempotencyKey: args.key,
    respectsGlobalPause: true,
    source: "user_chat",
    createdBy: String(args.runtime.agentId),
    ownerVisible: true,
    executionProfile: "bg-light-30s",
    metadata: {
      [MESSAGE_DRAFT_METADATA_KEY]: {
        version: MESSAGE_DRAFT_PAYLOAD_VERSION,
        scheduledAtIso,
        draft: persistedDraftSnapshot(args.draft),
      },
    },
  });

  const actualSendAtMs = onceAtMs(task);
  const payload = readPayload(task);
  if (actualSendAtMs === null || !payload) {
    throw new ElizaError(
      "The durable scheduler returned an invalid deferred-message task.",
      {
        code: "MESSAGE_DRAFT_SCHEDULE_INVALID",
        context: { taskId: task.taskId, idempotencyKey: args.key },
        severity: "fatal",
      },
    );
  }
  if (actualSendAtMs !== args.sendAtMs) {
    throw new ElizaError(
      "Draft already has a durable schedule at a different delivery time.",
      {
        code: "MESSAGE_DRAFT_SCHEDULE_CONFLICT",
        context: {
          taskId: task.taskId,
          draftId: args.draft.draftId,
          existingSendAtMs: actualSendAtMs,
          requestedSendAtMs: args.sendAtMs,
        },
        severity: "ephemeral",
      },
    );
  }
  return {
    scheduledId: task.taskId,
    scheduledForMs: actualSendAtMs,
    commit: {
      kind: "durable",
      id: task.taskId,
      committedAt: payload.scheduledAtIso,
      idempotencyKey: args.key,
      replayed: payload.scheduledAtIso !== scheduledAtIso,
    },
  };
}

function previousSuccessfulDispatch(
  record: ScheduledTaskDispatchRecord,
): DispatchResult | null {
  const parsed = successfulDispatchSchema.safeParse(
    record.metadata?.lastDispatchResult,
  );
  if (!parsed.success) return null;
  return {
    ok: true,
    messageId: parsed.data.messageId,
    channelKey: MESSAGE_DRAFT_DISPATCH_CHANNEL,
  };
}

function readAttempt(
  record:
    | Pick<ScheduledTaskDispatchRecord, "metadata">
    | Pick<ScheduledTask, "metadata">,
): DeferredMessageAttempt | null {
  const parsed = deferredMessageAttemptSchema.safeParse(
    record.metadata?.[MESSAGE_DRAFT_ATTEMPT_METADATA_KEY],
  );
  return parsed.success ? parsed.data : null;
}

async function dispatchPersistedDraft(
  runtime: IAgentRuntime,
  record: ScheduledTaskDispatchRecord,
  bridgeInstanceId: string,
): Promise<DispatchResult> {
  const replay = previousSuccessfulDispatch(record);
  if (replay) return replay;

  const payload = readPayload(record);
  if (!payload) {
    return {
      ok: false,
      reason: "transport_error",
      userActionable: false,
      acceptance: "not_accepted",
      message: "Deferred message task is missing a valid draft snapshot.",
    };
  }
  const service = getDefaultTriageService();
  const adapter = service.getAdapter(payload.draft.source);
  if (adapter === undefined || !adapter.isAvailable(runtime)) {
    return {
      ok: false,
      reason: "disconnected",
      userActionable: true,
      acceptance: "not_accepted",
      message: `${payload.draft.source} is not connected.`,
    };
  }
  const runner = getScheduledTaskRunner(runtime, {
    agentId: String(runtime.agentId),
  });
  await runner.apply(record.taskId, "edit", {
    metadata: {
      ...(record.metadata ?? {}),
      [MESSAGE_DRAFT_ATTEMPT_METADATA_KEY]: {
        version: MESSAGE_DRAFT_ATTEMPT_VERSION,
        bridgeInstanceId,
        startedAtIso: record.firedAtIso,
        state: "dispatching",
      } satisfies DeferredMessageAttempt,
    },
  });
  try {
    const sent = await service.sendPersistedDraft(runtime, payload.draft);
    if (!sent.sentExternalId) {
      return {
        ok: false,
        reason: "transport_error",
        userActionable: false,
        acceptance: "unknown",
        message: "Connector returned without an accepted message identifier.",
      };
    }
    return {
      ok: true,
      messageId: sent.sentExternalId,
      channelKey: MESSAGE_DRAFT_DISPATCH_CHANNEL,
      metadata: {
        draftId: payload.draft.draftId,
        source: payload.draft.source,
      },
    };
  } catch (error) {
    // error-policy:J1 the contributed dispatcher is the transport boundary;
    // the runner consumes this typed failure without inferring success.
    runtime.reportError("lifeops:message-draft-dispatch", error, {
      taskId: record.taskId,
      draftId: payload.draft.draftId,
      source: payload.draft.source,
    });
    if (
      error instanceof ElizaError &&
      error.code === "MESSAGE_ADAPTER_UNAVAILABLE"
    ) {
      return {
        ok: false,
        reason: "disconnected",
        userActionable: true,
        acceptance: "not_accepted",
        message: error.message,
      };
    }
    return {
      ok: false,
      reason: "transport_error",
      userActionable: false,
      acceptance: "unknown",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

interface InstalledMessageDraftBridge {
  bridgeInstanceId: string;
  cleanup(): void;
}

const installedBridges = new WeakMap<
  IAgentRuntime,
  InstalledMessageDraftBridge
>();

/**
 * Convert attempts claimed by an earlier process into explicit unknown
 * outcomes. Retrying would risk a duplicate because the connector may have
 * accepted the message before the prior process lost its result.
 */
export async function reconcileInterruptedMessageDraftDispatches(
  runtime: IAgentRuntime,
): Promise<string[]> {
  const installed = installedBridges.get(runtime);
  if (!installed) {
    throw new ElizaError(
      "The deferred-message bridge must be registered before reconciliation.",
      {
        code: "MESSAGE_DRAFT_RECONCILIATION_UNAVAILABLE",
        severity: "fatal",
      },
    );
  }
  const runner = getScheduledTaskRunner(runtime, {
    agentId: String(runtime.agentId),
  });
  const fired = await runner.list({ status: "fired" });
  const reconciledTaskIds: string[] = [];
  for (const task of fired) {
    if (
      task.output?.destination !== "channel" ||
      task.output.target !== MESSAGE_DRAFT_DISPATCH_CHANNEL
    ) {
      continue;
    }
    const payload = readPayload(task);
    const attempt = readAttempt(task);
    if (
      !payload ||
      !attempt ||
      attempt.bridgeInstanceId === installed.bridgeInstanceId
    ) {
      continue;
    }
    const reconciledAtIso = new Date().toISOString();
    const unknownResult: DispatchResult = {
      ok: false,
      reason: "transport_error",
      userActionable: true,
      acceptance: "unknown",
      message:
        "The process stopped during delivery. Verify the provider conversation before sending again.",
    };
    await runner.apply(task.taskId, "edit", {
      metadata: {
        ...(task.metadata ?? {}),
        [MESSAGE_DRAFT_ATTEMPT_METADATA_KEY]: {
          ...attempt,
          state: "outcome_unknown",
          reconciledAtIso,
        } satisfies DeferredMessageAttempt,
        lastDispatchResult: unknownResult,
      },
    });
    await runner.pipeline(task.taskId, "failed");
    runtime.reportError(
      "lifeops:message-draft-reconciliation",
      new ElizaError(
        "A deferred message delivery was interrupted with an unknown provider outcome.",
        {
          code: "MESSAGE_DRAFT_DELIVERY_OUTCOME_UNKNOWN",
          context: {
            taskId: task.taskId,
            draftId: payload.draft.draftId,
            source: payload.draft.source,
            startedAtIso: attempt.startedAtIso,
          },
          severity: "fatal",
        },
      ),
      {
        taskId: task.taskId,
        draftId: payload.draft.draftId,
        source: payload.draft.source,
      },
    );
    reconciledTaskIds.push(task.taskId);
  }
  return reconciledTaskIds;
}

export function registerMessageDraftScheduledTaskBridge(
  runtime: IAgentRuntime,
  options: { bridgeInstanceId?: string } = {},
): void {
  if (installedBridges.has(runtime)) return;
  const bridgeInstanceId = options.bridgeInstanceId ?? randomUUID();
  const contribution: ScheduledTaskChannelDispatcherContribution = {
    channelKey: MESSAGE_DRAFT_DISPATCH_CHANNEL,
    dispatch: (record) =>
      dispatchPersistedDraft(runtime, record, bridgeInstanceId),
  };
  const unregisterScheduler = registerDeferredMessageScheduler(runtime, {
    schedule: ({ draft, sendAtMs }) =>
      schedulePersistedDraft({ runtime, draft, sendAtMs }),
  });
  try {
    registerScheduledTaskChannelDispatcher(runtime, contribution);
  } catch (error) {
    // error-policy:J6 registration rollback removes the in-memory port before
    // the original wiring failure propagates.
    unregisterScheduler();
    throw error;
  }
  installedBridges.set(runtime, {
    bridgeInstanceId,
    cleanup: () => {
      unregisterScheduledTaskChannelDispatcher(
        runtime,
        MESSAGE_DRAFT_DISPATCH_CHANNEL,
        contribution,
      );
      unregisterScheduler();
      installedBridges.delete(runtime);
    },
  });
}

export function unregisterMessageDraftScheduledTaskBridge(
  runtime: IAgentRuntime,
): void {
  installedBridges.get(runtime)?.cleanup();
}
