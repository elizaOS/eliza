/**
 * Audience-scoped egress policy for LifeOps model context.
 *
 * The gate binds the requesting entity, requested source persona, destination
 * room, stored room type, and current participant snapshot before any private
 * LifeOps data is loaded. Callers receive a serializable receipt for every
 * source so denied data can be audited without placing the payload in logs,
 * receipts, or model context.
 */
import {
  ChannelType,
  type IAgentRuntime,
  type Memory,
  type UUID,
} from "@elizaos/core";

export const LIFEOPS_AUDIENCE_SOURCE_KINDS = [
  "gmail",
  "calendar",
  "private_memory",
  "public_memory",
] as const;

export type LifeOpsAudienceSourceKind =
  (typeof LIFEOPS_AUDIENCE_SOURCE_KINDS)[number];

export const LIFEOPS_AUDIENCE_CLASSIFICATIONS = [
  "private",
  "persona_scoped",
  "public",
] as const;

export type LifeOpsAudienceClassification =
  (typeof LIFEOPS_AUDIENCE_CLASSIFICATIONS)[number];

export type LifeOpsAudienceDecision = "include" | "exclude";

export type LifeOpsAudienceReason =
  | "included_private_dm"
  | "included_public_group"
  | "included_public_dm"
  | "excluded_non_owner_requester"
  | "excluded_missing_room"
  | "excluded_missing_participants"
  | "excluded_metadata_lookup_failed"
  | "excluded_channel_type_mismatch"
  | "excluded_requester_not_participant"
  | "excluded_agent_not_participant"
  | "excluded_unexpected_participants"
  | "excluded_group_destination"
  | "excluded_missing_source_persona"
  | "excluded_cross_persona"
  | "excluded_unknown_source_classification";

export interface LifeOpsAudienceSource {
  kind: LifeOpsAudienceSourceKind;
  id: string;
  classification: LifeOpsAudienceClassification;
  persona?: string | null;
}

export interface LifeOpsAudienceReceipt {
  requestEntityId: string;
  destinationRoomId: string;
  destinationRoomType: string | null;
  messageChannelType: string | null;
  participantEntityIds: string[];
  source: {
    kind: LifeOpsAudienceSourceKind;
    id: string;
    classification: LifeOpsAudienceClassification;
    persona: string | null;
  };
  requestingPersona: string | null;
  decision: LifeOpsAudienceDecision;
  reason: LifeOpsAudienceReason;
}

export interface LifeOpsAudienceGateResult {
  receipts: LifeOpsAudienceReceipt[];
  includedSources: LifeOpsAudienceSource[];
  canLoadPrivateContext: boolean;
}

const PRIVATE_ROOM_TYPES = new Set<string>([
  ChannelType.DM,
  ChannelType.VOICE_DM,
]);
const SOURCE_CLASSIFICATIONS = new Set<string>(
  LIFEOPS_AUDIENCE_CLASSIFICATIONS,
);
function readRequestingPersona(runtime: IAgentRuntime): string | null {
  const raw = runtime.character.name;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function sortedParticipants(participants: readonly string[]): string[] {
  return [
    ...new Set(participants.map((participant) => String(participant))),
  ].sort();
}

function baseReceipt(args: {
  message: Memory;
  source: LifeOpsAudienceSource;
  requestingPersona: string | null;
  roomType: string | null;
  participants: readonly string[];
  reason: LifeOpsAudienceReason;
  decision: LifeOpsAudienceDecision;
}): LifeOpsAudienceReceipt {
  const messageChannelType =
    typeof args.message.content.channelType === "string"
      ? args.message.content.channelType
      : null;
  return {
    requestEntityId: args.message.entityId,
    destinationRoomId: args.message.roomId,
    destinationRoomType: args.roomType,
    messageChannelType,
    participantEntityIds: [...args.participants],
    source: {
      kind: args.source.kind,
      id: args.source.id,
      classification: args.source.classification,
      persona: args.source.persona?.trim() || null,
    },
    requestingPersona: args.requestingPersona,
    decision: args.decision,
    reason: args.reason,
  };
}

function sourcePersonaReason(
  source: LifeOpsAudienceSource,
  requestingPersona: string | null,
): LifeOpsAudienceReason | null {
  if (!SOURCE_CLASSIFICATIONS.has(source.classification)) {
    return "excluded_unknown_source_classification";
  }
  if (source.classification === "public") {
    return null;
  }
  const sourcePersona = source.persona?.trim();
  if (!sourcePersona || !requestingPersona) {
    return "excluded_missing_source_persona";
  }
  return sourcePersona === requestingPersona ? null : "excluded_cross_persona";
}

function classifyDestination(args: {
  runtime: IAgentRuntime;
  message: Memory;
  roomType: string;
  participants: readonly string[];
}): LifeOpsAudienceReason | null {
  const messageChannelType =
    typeof args.message.content.channelType === "string"
      ? args.message.content.channelType
      : null;
  if (!messageChannelType) {
    return "excluded_channel_type_mismatch";
  }
  if (args.roomType !== messageChannelType) {
    return "excluded_channel_type_mismatch";
  }
  if (!args.participants.includes(args.message.entityId)) {
    return "excluded_requester_not_participant";
  }
  if (!args.participants.includes(args.runtime.agentId)) {
    return "excluded_agent_not_participant";
  }
  if (PRIVATE_ROOM_TYPES.has(args.roomType)) {
    const expected = sortedParticipants([
      args.message.entityId,
      args.runtime.agentId,
    ]);
    return args.participants.length === expected.length &&
      args.participants.every(
        (participant, index) => participant === expected[index],
      )
      ? null
      : "excluded_unexpected_participants";
  }
  return "excluded_group_destination";
}

export async function evaluateLifeOpsAudiencePolicy(args: {
  runtime: IAgentRuntime;
  message: Memory;
  sources: readonly LifeOpsAudienceSource[];
  hasOwnerAccess: (runtime: IAgentRuntime, message: Memory) => Promise<boolean>;
}): Promise<LifeOpsAudienceGateResult> {
  const requestingPersona = readRequestingPersona(args.runtime);
  let metadataLookupFailed = false;
  let room: Awaited<ReturnType<IAgentRuntime["getRoom"]>> = null;
  try {
    room = await args.runtime.getRoom(args.message.roomId as UUID);
  } catch {
    // error-policy:J4 audience metadata must fail closed before private context loads.
    metadataLookupFailed = true;
  }
  const roomType = room?.type ?? null;
  let participantIds: string[] = [];
  if (room) {
    try {
      const participants = await args.runtime.getParticipantsForRoom(
        args.message.roomId as UUID,
      );
      participantIds = Array.isArray(participants)
        ? sortedParticipants(participants)
        : [];
    } catch {
      // error-policy:J4 audience metadata must fail closed before private context loads.
      metadataLookupFailed = true;
    }
  }
  const includedSources: LifeOpsAudienceSource[] = [];

  const denyAll = (
    reason: LifeOpsAudienceReason,
  ): LifeOpsAudienceGateResult => ({
    receipts: args.sources.map((source) =>
      baseReceipt({
        message: args.message,
        source,
        requestingPersona,
        roomType,
        participants: participantIds,
        reason,
        decision: "exclude",
      }),
    ),
    includedSources,
    canLoadPrivateContext: false,
  });

  const hasRequesterOwnerAccess = await args
    .hasOwnerAccess(args.runtime, args.message)
    .catch(() => {
      // error-policy:J4 owner-access resolution failure must deny private context.
      return false;
    });
  if (!hasRequesterOwnerAccess) {
    return denyAll("excluded_non_owner_requester");
  }
  if (metadataLookupFailed) {
    return denyAll("excluded_metadata_lookup_failed");
  }
  if (!room || !roomType) {
    return denyAll("excluded_missing_room");
  }
  if (participantIds.length === 0) {
    return denyAll("excluded_missing_participants");
  }

  const destinationReason = classifyDestination({
    runtime: args.runtime,
    message: args.message,
    roomType,
    participants: participantIds,
  });

  const receipts = args.sources.map((source) => {
    const personaReason = sourcePersonaReason(source, requestingPersona);
    const reason = personaReason ?? destinationReason;
    if (reason) {
      if (
        source.classification === "public" &&
        reason === "excluded_group_destination"
      ) {
        includedSources.push(source);
        return baseReceipt({
          message: args.message,
          source,
          requestingPersona,
          roomType,
          participants: participantIds,
          reason: "included_public_group",
          decision: "include",
        });
      }
      return baseReceipt({
        message: args.message,
        source,
        requestingPersona,
        roomType,
        participants: participantIds,
        reason,
        decision: "exclude",
      });
    }
    includedSources.push(source);
    const includeReason =
      source.classification === "public"
        ? "included_public_dm"
        : PRIVATE_ROOM_TYPES.has(roomType)
          ? "included_private_dm"
          : "included_public_group";
    return baseReceipt({
      message: args.message,
      source,
      requestingPersona,
      roomType,
      participants: participantIds,
      reason: includeReason,
      decision: "include",
    });
  });

  return {
    receipts,
    includedSources,
    canLoadPrivateContext:
      receipts.some(
        (receipt) =>
          receipt.decision === "include" &&
          receipt.source.classification !== "public",
      ) && receipts.every((receipt) => receipt.decision === "include"),
  };
}
