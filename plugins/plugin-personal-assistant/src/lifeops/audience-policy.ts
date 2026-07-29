/**
 * Shared audience authorization for owner-private Personal Assistant reads.
 *
 * This module deliberately separates actor authorization (the owner) from
 * destination authorization (the audience that will receive the result).  All
 * private providers/actions call the same boundary before loading data.  The
 * resulting envelope is attached to the inbound message and is revalidated by
 * the production outgoing/stream hooks immediately before delivery.
 */
import { hasOwnerAccess } from "@elizaos/agent";
import {
  ChannelType,
  type IAgentRuntime,
  type Memory,
  type PipelineHookContext,
  type UUID,
} from "@elizaos/core";

export const LIFEOPS_AUDIENCE_SOURCE_KINDS = [
  "gmail",
  "calendar",
  "private_memory",
  "approvals",
] as const;

export type LifeOpsAudienceSourceKind =
  (typeof LIFEOPS_AUDIENCE_SOURCE_KINDS)[number];

/** A callsite may name a loader, but may not assert its persona/security scope. */
export interface LifeOpsAudienceSource {
  kind: LifeOpsAudienceSourceKind;
  id: string;
}

export type LifeOpsAudienceDecision = "include" | "exclude";
export type LifeOpsAudienceReason =
  | "included_private_audience"
  | "excluded_non_owner_requester"
  | "excluded_owner_lookup_failed"
  | "excluded_missing_room"
  | "excluded_missing_participants"
  | "excluded_metadata_lookup_failed"
  | "excluded_untrusted_loader_identity"
  | "excluded_audience_class_mismatch"
  | "excluded_requester_not_participant"
  | "excluded_agent_not_participant"
  | "excluded_unexpected_participants"
  | "excluded_group_destination"
  | "excluded_audience_changed";

export type LifeOpsAudienceClass = "private" | "group" | "unknown";

export interface LifeOpsAudienceEnvelope {
  roomId: string;
  requestEntityId: string;
  trustedAgentId: string;
  roomAudienceClass: LifeOpsAudienceClass;
  messageAudienceClass: LifeOpsAudienceClass;
  participantEntityIds: string[];
  /** Deterministic membership/version token re-read at every delivery seam. */
  audienceVersion: string;
}

export interface LifeOpsAudienceReceipt {
  requestEntityId: string;
  destinationRoomId: string;
  destinationRoomType: string | null;
  messageChannelType: string | null;
  roomAudienceClass: LifeOpsAudienceClass;
  messageAudienceClass: LifeOpsAudienceClass;
  participantEntityIds: string[];
  audienceVersion: string | null;
  source: {
    kind: LifeOpsAudienceSourceKind;
    id: string;
    /** Loaded from the persisted Agent record, never character.name/content. */
    trustedAgentId: string | null;
  };
  decision: LifeOpsAudienceDecision;
  reason: LifeOpsAudienceReason;
}

export interface LifeOpsAudienceGateResult {
  receipts: LifeOpsAudienceReceipt[];
  /**
   * The gate is all-or-nothing per audience: every source kind is owner-private,
   * so authorization never varies between the sources of one request. Callers
   * read this instead of a per-source include list.
   */
  canLoadPrivateContext: boolean;
  envelope: LifeOpsAudienceEnvelope | null;
}

const PRIVATE_TYPES = new Set<string>([
  ChannelType.DM,
  ChannelType.VOICE_DM,
  ChannelType.SELF,
  ChannelType.API,
]);
const GROUP_TYPES = new Set<string>([
  ChannelType.GROUP,
  ChannelType.VOICE_GROUP,
  ChannelType.FEED,
  ChannelType.THREAD,
  ChannelType.WORLD,
  ChannelType.FORUM,
]);
const ENVELOPE_METADATA_KEY = "lifeOpsAudienceEnvelope";
/**
 * Streaming revalidation staleness bound. The stream hook fires per token; a
 * full DB re-read (room + participants) per token is a serial two-query tax on
 * every streamed chunk. A successful revalidation is trusted for this window,
 * so a mid-stream audience change is caught within at most this many
 * milliseconds instead of on the very next token. The final
 * `outgoing_before_deliver` revalidation always re-reads the DB uncached.
 */
const STREAM_REVALIDATION_TTL_MS = 500;
const streamRevalidationCacheByRuntime = new WeakMap<
  IAgentRuntime,
  Map<string, { audienceVersion: string; validatedAt: number }>
>();
const activeEnvelopeByRuntime = new WeakMap<
  IAgentRuntime,
  Map<string, LifeOpsAudienceEnvelope>
>();

export class LifeOpsAudienceDeliveryDeniedError extends Error {
  constructor() {
    super(
      "Private context delivery cancelled because the destination audience changed",
    );
    this.name = "LifeOpsAudienceDeliveryDeniedError";
  }
}

export function classifyLifeOpsAudience(
  channelType: string | null | undefined,
): LifeOpsAudienceClass {
  if (!channelType) return "unknown";
  if (PRIVATE_TYPES.has(channelType)) return "private";
  if (GROUP_TYPES.has(channelType)) return "group";
  return "unknown";
}

function sortedParticipants(participants: readonly string[]): string[] {
  return [...new Set(participants.map(String))].sort();
}

function audienceVersion(args: {
  roomId: string;
  roomType: string | null;
  participants: readonly string[];
}): string {
  return `${args.roomId}|${args.roomType ?? "unknown"}|${args.participants.join(",")}`;
}

function activeEnvelopes(
  runtime: IAgentRuntime,
): Map<string, LifeOpsAudienceEnvelope> {
  let envelopes = activeEnvelopeByRuntime.get(runtime);
  if (!envelopes) {
    envelopes = new Map();
    activeEnvelopeByRuntime.set(runtime, envelopes);
  }
  return envelopes;
}

function attachEnvelope(
  runtime: IAgentRuntime,
  message: Memory,
  envelope: LifeOpsAudienceEnvelope,
): void {
  message.metadata = {
    ...(message.metadata ?? { type: "message" }),
    [ENVELOPE_METADATA_KEY]: envelope,
  } as Memory["metadata"];
  activeEnvelopes(runtime).set(message.roomId, envelope);
}

function readEnvelope(
  message: Memory | undefined,
): LifeOpsAudienceEnvelope | null {
  if (!message?.metadata || typeof message.metadata !== "object") return null;
  const candidate = (message.metadata as Record<string, unknown>)[
    ENVELOPE_METADATA_KEY
  ];
  if (!candidate || typeof candidate !== "object") return null;
  const envelope = candidate as Partial<LifeOpsAudienceEnvelope>;
  return typeof envelope.roomId === "string" &&
    typeof envelope.audienceVersion === "string" &&
    Array.isArray(envelope.participantEntityIds)
    ? (envelope as LifeOpsAudienceEnvelope)
    : null;
}

function receipt(args: {
  message: Memory;
  source: LifeOpsAudienceSource;
  trustedAgentId: string | null;
  roomType: string | null;
  roomClass: LifeOpsAudienceClass;
  messageClass: LifeOpsAudienceClass;
  participants: string[];
  version: string | null;
  decision: LifeOpsAudienceDecision;
  reason: LifeOpsAudienceReason;
}): LifeOpsAudienceReceipt {
  return {
    requestEntityId: args.message.entityId,
    destinationRoomId: args.message.roomId,
    destinationRoomType: args.roomType,
    messageChannelType:
      typeof args.message.content.channelType === "string"
        ? args.message.content.channelType
        : null,
    roomAudienceClass: args.roomClass,
    messageAudienceClass: args.messageClass,
    participantEntityIds: args.participants,
    audienceVersion: args.version,
    source: {
      kind: args.source.kind,
      id: args.source.id,
      trustedAgentId: args.trustedAgentId,
    },
    decision: args.decision,
    reason: args.reason,
  };
}

/**
 * Authorize private retrieval and bind its provenance to the persisted Agent
 * identity loaded by the runtime.  Display names and message-supplied persona
 * fields are intentionally ignored.
 */
export async function evaluateLifeOpsAudiencePolicy(args: {
  runtime: IAgentRuntime;
  message: Memory;
  sources: readonly LifeOpsAudienceSource[];
  hasOwnerAccess: (runtime: IAgentRuntime, message: Memory) => Promise<boolean>;
}): Promise<LifeOpsAudienceGateResult> {
  let room: Awaited<ReturnType<IAgentRuntime["getRoom"]>> = null;
  let participants: string[] = [];
  let trustedAgentId: string | null = null;
  let metadataFailure = false;
  let ownerLookupFailure = false;

  try {
    room = await args.runtime.getRoom(args.message.roomId as UUID);
    if (room) {
      const values = await args.runtime.getParticipantsForRoom(
        args.message.roomId as UUID,
      );
      participants = Array.isArray(values) ? sortedParticipants(values) : [];
    }
    // error-policy:J7 room/participant lookup is a diagnostic read; a failure
    // must be reported and fail the gate closed, never abort the whole turn.
  } catch (error) {
    metadataFailure = true;
    args.runtime.reportError("LifeOpsAudience.metadata", error, {
      roomId: args.message.roomId,
    });
  }

  try {
    const persistedAgent = await args.runtime.getAgent(args.runtime.agentId);
    trustedAgentId = persistedAgent?.id ?? null;
    // error-policy:J7 persisted-agent read is a diagnostic read; report and
    // fail closed rather than killing the turn.
  } catch (error) {
    metadataFailure = true;
    args.runtime.reportError("LifeOpsAudience.loaderIdentity", error, {
      agentId: args.runtime.agentId,
    });
  }

  let isOwner = false;
  try {
    isOwner = await args.hasOwnerAccess(args.runtime, args.message);
    // error-policy:J7 a broken role lookup is reported and denied under its own
    // reason so it is never read back as "this requester is not the owner".
  } catch (error) {
    ownerLookupFailure = true;
    args.runtime.reportError("LifeOpsAudience.ownerAccess", error, {
      entityId: args.message.entityId,
      roomId: args.message.roomId,
    });
  }

  const roomType = room?.type ?? null;
  const messageType =
    typeof args.message.content.channelType === "string"
      ? args.message.content.channelType
      : null;
  const roomClass = classifyLifeOpsAudience(roomType);
  const messageClass = classifyLifeOpsAudience(messageType);
  const version = room
    ? audienceVersion({
        roomId: args.message.roomId,
        roomType,
        participants,
      })
    : null;

  let reason: LifeOpsAudienceReason | null = null;
  if (ownerLookupFailure) reason = "excluded_owner_lookup_failed";
  else if (!isOwner) reason = "excluded_non_owner_requester";
  else if (metadataFailure) reason = "excluded_metadata_lookup_failed";
  else if (!trustedAgentId || trustedAgentId !== args.runtime.agentId)
    reason = "excluded_untrusted_loader_identity";
  else if (!room || !roomType) reason = "excluded_missing_room";
  else if (participants.length === 0) reason = "excluded_missing_participants";
  else if (roomClass === "group" || messageClass === "group")
    reason = "excluded_group_destination";
  else if (roomClass !== "private" || messageClass !== "private")
    reason = "excluded_audience_class_mismatch";
  else if (!participants.includes(args.message.entityId))
    reason = "excluded_requester_not_participant";
  else if (!participants.includes(args.runtime.agentId))
    reason = "excluded_agent_not_participant";
  else {
    const expected = sortedParticipants([
      args.message.entityId,
      args.runtime.agentId,
    ]);
    if (
      participants.length !== expected.length ||
      !participants.every(
        (participant, index) => participant === expected[index],
      )
    ) {
      reason = "excluded_unexpected_participants";
    }
  }

  if (reason) {
    return {
      receipts: args.sources.map((source) =>
        receipt({
          message: args.message,
          source,
          trustedAgentId,
          roomType,
          roomClass,
          messageClass,
          participants,
          version,
          decision: "exclude",
          reason,
        }),
      ),
      canLoadPrivateContext: false,
      envelope: null,
    };
  }

  const envelope: LifeOpsAudienceEnvelope = {
    roomId: args.message.roomId,
    requestEntityId: args.message.entityId,
    trustedAgentId: trustedAgentId as string,
    roomAudienceClass: roomClass,
    messageAudienceClass: messageClass,
    participantEntityIds: participants,
    audienceVersion: version as string,
  };
  attachEnvelope(args.runtime, args.message, envelope);
  return {
    receipts: args.sources.map((source) =>
      receipt({
        message: args.message,
        source,
        trustedAgentId,
        roomType,
        roomClass,
        messageClass,
        participants,
        version,
        decision: "include",
        reason: "included_private_audience",
      }),
    ),
    canLoadPrivateContext: true,
    envelope,
  };
}

/** Shared production retrieval boundary used by private providers/actions. */
export async function authorizeLifeOpsPrivateContext(args: {
  runtime: IAgentRuntime;
  message: Memory;
  sources: readonly LifeOpsAudienceSource[];
}): Promise<LifeOpsAudienceGateResult> {
  return evaluateLifeOpsAudiencePolicy({
    ...args,
    hasOwnerAccess,
  });
}

/** Re-read the authoritative room and participants immediately before send. */
export async function revalidateLifeOpsAudienceEnvelope(
  runtime: IAgentRuntime,
  envelope: LifeOpsAudienceEnvelope,
): Promise<boolean> {
  try {
    const room = await runtime.getRoom(envelope.roomId as UUID);
    if (!room) return false;
    const participants = sortedParticipants(
      await runtime.getParticipantsForRoom(envelope.roomId as UUID),
    );
    const currentVersion = audienceVersion({
      roomId: envelope.roomId,
      roomType: room.type,
      participants,
    });
    return (
      currentVersion === envelope.audienceVersion &&
      classifyLifeOpsAudience(room.type) === "private" &&
      participants.includes(envelope.requestEntityId) &&
      participants.includes(envelope.trustedAgentId)
    );
  } catch (error) {
    runtime.reportError("LifeOpsAudience.deliveryRevalidation", error, {
      roomId: envelope.roomId,
    });
    return false;
  }
}

function streamRevalidationCache(
  runtime: IAgentRuntime,
): Map<string, { audienceVersion: string; validatedAt: number }> {
  let cache = streamRevalidationCacheByRuntime.get(runtime);
  if (!cache) {
    cache = new Map();
    streamRevalidationCacheByRuntime.set(runtime, cache);
  }
  return cache;
}

/**
 * Streaming-path revalidation: trusts a successful full revalidation for
 * `STREAM_REVALIDATION_TTL_MS` so per-token cost is bounded. A failure is
 * never cached — the envelope is dropped immediately by the caller.
 */
async function revalidateLifeOpsAudienceForStream(
  runtime: IAgentRuntime,
  envelope: LifeOpsAudienceEnvelope,
): Promise<boolean> {
  const cache = streamRevalidationCache(runtime);
  const cached = cache.get(envelope.roomId);
  if (
    cached &&
    cached.audienceVersion === envelope.audienceVersion &&
    Date.now() - cached.validatedAt < STREAM_REVALIDATION_TTL_MS
  ) {
    return true;
  }
  const authorized = await revalidateLifeOpsAudienceEnvelope(runtime, envelope);
  if (authorized) {
    cache.set(envelope.roomId, {
      audienceVersion: envelope.audienceVersion,
      validatedAt: Date.now(),
    });
  } else {
    cache.delete(envelope.roomId);
  }
  return authorized;
}

export async function assertLifeOpsAudienceAtDelivery(
  runtime: IAgentRuntime,
  message: Memory,
  envelope?: LifeOpsAudienceEnvelope | null,
): Promise<void> {
  const bound = envelope ?? readEnvelope(message);
  if (!bound) return;
  if (!(await revalidateLifeOpsAudienceEnvelope(runtime, bound))) {
    activeEnvelopes(runtime).delete(bound.roomId);
    streamRevalidationCache(runtime).delete(bound.roomId);
    throw new LifeOpsAudienceDeliveryDeniedError();
  }
}

/**
 * Production delivery boundary.  Final callback delivery and every streamed
 * model chunk pass through these core pipeline phases before reaching a client.
 */
export function registerLifeOpsAudienceDeliveryHook(
  runtime: IAgentRuntime,
): void {
  for (const id of [
    "lifeops:audience-stream-delivery",
    "lifeops:audience-final-delivery",
  ]) {
    runtime.unregisterPipelineHook(id);
  }
  runtime.registerPipelineHook({
    id: "lifeops:audience-stream-delivery",
    phase: "model_stream_chunk",
    schedule: "serial",
    mutatesPrimary: true,
    async handler(hookRuntime, context: PipelineHookContext) {
      if (context.phase !== "model_stream_chunk" || !context.roomId) return;
      const envelope = activeEnvelopes(hookRuntime).get(context.roomId);
      if (!envelope) return;
      if (!(await revalidateLifeOpsAudienceForStream(hookRuntime, envelope))) {
        activeEnvelopes(hookRuntime).delete(envelope.roomId);
        streamRevalidationCache(hookRuntime).delete(envelope.roomId);
        // Pipeline hooks are diagnostics-safe and intentionally swallow throws.
        // Mutating the primary chunk is therefore the enforceable send boundary.
        context.chunk = "";
        if (context.accumulated !== undefined) context.accumulated = "";
      }
    },
  });
  runtime.registerPipelineHook({
    id: "lifeops:audience-final-delivery",
    phase: "outgoing_before_deliver",
    schedule: "serial",
    mutatesPrimary: true,
    async handler(hookRuntime, context: PipelineHookContext) {
      if (context.phase !== "outgoing_before_deliver") return;
      const envelope = readEnvelope(context.message);
      if (!envelope) return;
      const stillAuthorized = await revalidateLifeOpsAudienceEnvelope(
        hookRuntime,
        envelope,
      );
      activeEnvelopes(hookRuntime).delete(envelope.roomId);
      streamRevalidationCache(hookRuntime).delete(envelope.roomId);
      if (!stillAuthorized) {
        const responseId = context.content.responseId;
        const inReplyTo = context.content.inReplyTo;
        for (const key of Object.keys(context.content)) {
          delete (context.content as Record<string, unknown>)[key];
        }
        Object.assign(context.content, {
          text: "Private context delivery was cancelled because the destination audience changed.",
          actions: ["REPLY"],
          ...(responseId ? { responseId } : {}),
          ...(inReplyTo ? { inReplyTo } : {}),
        });
      }
    },
  });
}
