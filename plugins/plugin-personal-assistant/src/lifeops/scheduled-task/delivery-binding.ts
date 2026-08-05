import {
  evaluateOwnerExclusiveDisclosure,
  getTrustedDeliveryAudience,
  type IAgentRuntime,
  MESSAGE_SOURCES,
  type Memory,
  type MessageSourceSentinel,
} from "@elizaos/core";
import type { ScheduledTaskDispatchRecord } from "./index.js";

/**
 * Provenances that must never reach outbound connector dispatch.
 *
 * Enumerated deliberately rather than derived from `Object.values`. This is a
 * fail-open boundary: a provenance the guard does not name is BOUND, so the
 * cost of forgetting one is an internal turn rewritten into an unavailable
 * connector send. Spelling every sentinel out means adding one to
 * `@elizaos/core`'s `message-source.ts` leaves a missing key here and fails
 * typecheck, forcing a decision instead of silently widening the guard.
 *
 * `api` is not a core sentinel — it is a first-party transport label — so it
 * lives alongside the record rather than inside it.
 */
const INTERNAL_MESSAGE_SOURCES: Record<MessageSourceSentinel, true> = {
  [MESSAGE_SOURCES.CLIENT_CHAT]: true,
  [MESSAGE_SOURCES.SUB_AGENT]: true,
  [MESSAGE_SOURCES.CODING_AGENT]: true,
  [MESSAGE_SOURCES.AGENT_GREETING]: true,
  [MESSAGE_SOURCES.TRIGGER_PROMPT]: true,
};

const API_TRANSPORT_SOURCE = "api";

/** Whether `source` names an internally-originated turn (#17747). */
export function isInternalMessageSource(
  source: string | undefined,
): source is string {
  if (!source) return false;
  return (
    source === API_TRANSPORT_SOURCE ||
    Object.hasOwn(INTERNAL_MESSAGE_SOURCES, source)
  );
}

export const SCHEDULED_TASK_DELIVERY_BINDING_KEY = "chatDeliveryBinding";

export interface ScheduledTaskChatDeliveryBinding {
  version: 1;
  source: string;
  roomId: string;
  channelId: string;
  accountId?: string;
  audience: {
    kind: "direct" | "voice_private";
    provenance: "canonical_room";
    ownerEntityId: string;
    agentEntityId: string;
    participantEntityIds: string[];
    membershipVersion: string;
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function canonicalParticipants(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function membershipVersion(values: readonly string[]): string {
  return canonicalParticipants(values).join("\u0000");
}

/**
 * Capture the connector destination from server-attested canonical room state.
 * Model parameters and message metadata are deliberately not consulted for the
 * destination. Unattested/internal/API turns keep the existing in-app path.
 */
export async function bindScheduledTaskToInboundChat(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<ScheduledTaskChatDeliveryBinding | null> {
  const decision = evaluateOwnerExclusiveDisclosure(message);
  const audience = getTrustedDeliveryAudience(message);
  if (
    !decision.allowed ||
    decision.basis !== "owner_private_destination" ||
    !audience ||
    audience.provenance !== "canonical_room" ||
    (audience.kind !== "direct" && audience.kind !== "voice_private") ||
    !audience.canonicalOwnerEntityId
  ) {
    return null;
  }

  // Canonical owner-only audience attestation is shared by connector DMs and
  // first-party/API turns. A first-party request can target a room whose
  // canonical source names the owner's preferred connector, so classify the
  // inbound envelope before consulting that room. Otherwise internal scenario
  // and API turns are rewritten into unavailable outbound connector sends and
  // planner idempotency keys leak a synthetic room suffix.
  const inboundSource =
    stringField(message.metadata?.source) ??
    stringField(message.content.source);
  if (isInternalMessageSource(inboundSource)) {
    return null;
  }

  const room = await runtime.getRoom(message.roomId);
  const source = stringField(room?.source);
  const channelId = stringField(room?.channelId);
  if (!room || !source || !channelId || room.id !== audience.roomId) {
    return null;
  }
  if (isInternalMessageSource(source) || channelId === room.id) {
    return null;
  }

  const roomMetadata =
    room.metadata && typeof room.metadata === "object"
      ? (room.metadata as Record<string, unknown>)
      : undefined;
  const accountId = stringField(roomMetadata?.accountId);
  return {
    version: 1,
    source,
    roomId: room.id,
    channelId,
    ...(accountId ? { accountId } : {}),
    audience: {
      kind: audience.kind,
      provenance: "canonical_room",
      ownerEntityId: audience.canonicalOwnerEntityId,
      agentEntityId: audience.agentEntityId,
      participantEntityIds: [...audience.participantEntityIds],
      membershipVersion: audience.membershipVersion,
    },
  };
}

function hasScheduledTaskChatDeliveryBinding(
  metadata: ScheduledTaskDispatchRecord["metadata"],
): boolean {
  return Boolean(
    metadata && Object.hasOwn(metadata, SCHEDULED_TASK_DELIVERY_BINDING_KEY),
  );
}

export function readScheduledTaskChatDeliveryBinding(
  metadata: ScheduledTaskDispatchRecord["metadata"],
): ScheduledTaskChatDeliveryBinding | null {
  const value = metadata?.[SCHEDULED_TASK_DELIVERY_BINDING_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const binding = value as Partial<ScheduledTaskChatDeliveryBinding>;
  const audience = binding.audience;
  if (
    binding.version !== 1 ||
    !stringField(binding.source) ||
    !stringField(binding.roomId) ||
    !stringField(binding.channelId) ||
    !audience ||
    audience.provenance !== "canonical_room" ||
    (audience.kind !== "direct" && audience.kind !== "voice_private") ||
    !stringField(audience.ownerEntityId) ||
    !stringField(audience.agentEntityId) ||
    !Array.isArray(audience.participantEntityIds) ||
    !stringField(audience.membershipVersion)
  ) {
    return null;
  }
  return binding as ScheduledTaskChatDeliveryBinding;
}

/** Re-read canonical room state immediately before visible connector egress. */
export async function revalidateScheduledTaskChatDeliveryBinding(
  runtime: IAgentRuntime,
  record: ScheduledTaskDispatchRecord,
): Promise<
  | { ok: true; binding: ScheduledTaskChatDeliveryBinding }
  | { ok: false; reason: string }
  | null
> {
  const binding = readScheduledTaskChatDeliveryBinding(record.metadata);
  if (!binding) {
    return hasScheduledTaskChatDeliveryBinding(record.metadata)
      ? { ok: false, reason: "delivery_binding_invalid" }
      : null;
  }
  if (
    record.channelKey !== binding.source ||
    record.output?.destination !== "channel" ||
    record.output.target !== `${binding.source}:${binding.channelId}`
  ) {
    return { ok: false, reason: "delivery_channel_changed" };
  }
  try {
    const [room, participants] = await Promise.all([
      runtime.getRoom(binding.roomId as never),
      runtime.getParticipantsForRoom(binding.roomId as never),
    ]);
    const current = canonicalParticipants(participants);
    const expected = canonicalParticipants(
      binding.audience.participantEntityIds,
    );
    const roomMetadata =
      room?.metadata && typeof room.metadata === "object"
        ? (room.metadata as Record<string, unknown>)
        : undefined;
    const currentAccountId = stringField(roomMetadata?.accountId);
    if (
      !room ||
      room.source !== binding.source ||
      room.channelId !== binding.channelId ||
      currentAccountId !== binding.accountId ||
      binding.audience.agentEntityId !== runtime.agentId ||
      current.length !== expected.length ||
      current.some((value, index) => value !== expected[index]) ||
      membershipVersion(current) !== binding.audience.membershipVersion ||
      current.length !== 2 ||
      !current.includes(binding.audience.ownerEntityId) ||
      !current.includes(binding.audience.agentEntityId)
    ) {
      return { ok: false, reason: "delivery_audience_changed" };
    }
    return { ok: true, binding };
  } catch (error) {
    runtime.reportError("lifeops:scheduled-task:delivery-binding", error, {
      taskId: record.taskId,
      roomId: binding.roomId,
    });
    return { ok: false, reason: "delivery_audience_lookup_failed" };
  }
}
