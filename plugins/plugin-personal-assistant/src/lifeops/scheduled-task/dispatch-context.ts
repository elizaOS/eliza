/**
 * Resolves a ScheduledTask's structural context request at fire time for the
 * owner-facing renderer. Reads stay inside PA's data boundary; the scheduling
 * spine receives only the typed, minimal result and never imports LifeOps.
 */

import {
  resolveKnowledgeGraphService,
  resolveOwnerEntityId,
} from "@elizaos/agent";
import {
  ElizaError,
  type IAgentRuntime,
  type Memory,
  toWellFormedUnicode,
  truncateWellFormed,
} from "@elizaos/core";
import type {
  OwnerFactsView,
  ScheduledTaskDispatchRecord,
  ScheduledTaskResolvedContext,
} from "@elizaos/plugin-scheduling";
import { createRecentTaskStatesProvider } from "../../providers/recent-task-states.js";
import {
  ownerFactsToView,
  resolveOwnerFactStore,
} from "../owner/fact-store.js";
import { readActivityProfile } from "./activity-gates.js";
import { readScheduledTaskChatDeliveryBinding } from "./delivery-binding.js";

const RECENT_CONVERSATION_LIMIT = 6;
const RECENT_CONVERSATION_LINE_LIMIT = 1_000;
const EVENT_PAYLOAD_LIMIT = 16_000;
const CONTEXT_ID_LIMIT = 100;
const CONTEXT_LOOKBACK_HOURS_LIMIT = 24 * 365;

function normalizeEventPayload(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return { unavailable: "not_serializable" };
    if (serialized.length > EVENT_PAYLOAD_LIMIT) {
      return { unavailable: "payload_too_large" };
    }
    return JSON.parse(serialized) as unknown;
  } catch {
    // error-policy:J3 untrusted-input sanitizing — the renderer receives an
    // explicit unavailable marker, never a fabricated event payload.
    return { unavailable: "not_serializable" };
  }
}

function contextError(
  message: string,
  code: string,
  record: ScheduledTaskDispatchRecord,
  cause?: unknown,
): ElizaError {
  return new ElizaError(message, {
    code,
    ...(cause === undefined ? {} : { cause }),
    context: { taskId: record.taskId, channelKey: record.channelKey },
    severity: "ephemeral",
  });
}

function assertContextRequestWithinLimits(
  record: ScheduledTaskDispatchRecord,
): void {
  const request = record.contextRequest;
  if (!request) return;
  if (
    (request.includeOwnerFacts?.length ?? 0) > 5 ||
    (request.includeEntities?.fields?.length ?? 0) > 4
  ) {
    throw contextError(
      "Scheduled dispatch context repeats more typed fields than the contract permits.",
      "SCHEDULED_DISPATCH_CONTEXT_FIELD_LIMIT_EXCEEDED",
      record,
    );
  }
  const oversized = [
    request.includeEntities?.entityIds,
    request.includeRelationships?.relationshipIds,
    request.includeRelationships?.forEntityIds,
    request.includeRelationships?.types,
  ].find((values) => (values?.length ?? 0) > CONTEXT_ID_LIMIT);
  if (oversized) {
    throw contextError(
      `Scheduled dispatch context exceeds the ${CONTEXT_ID_LIMIT}-item lookup boundary.`,
      "SCHEDULED_DISPATCH_CONTEXT_LIMIT_EXCEEDED",
      record,
    );
  }
  if (
    (request.includeRecentTaskStates?.lookbackHours ?? 0) >
    CONTEXT_LOOKBACK_HOURS_LIMIT
  ) {
    throw contextError(
      `Scheduled dispatch context exceeds the ${CONTEXT_LOOKBACK_HOURS_LIMIT}-hour lookback boundary.`,
      "SCHEDULED_DISPATCH_CONTEXT_LOOKBACK_EXCEEDED",
      record,
    );
  }
}

async function resolveRecentConversation(
  runtime: IAgentRuntime,
  record: ScheduledTaskDispatchRecord,
): Promise<string[] | undefined> {
  if (
    !record.ownerVisible ||
    typeof runtime.getMemoriesByRoomIds !== "function"
  ) {
    return undefined;
  }
  try {
    const binding = readScheduledTaskChatDeliveryBinding(record.metadata);
    let roomIds: string[];
    let ownerEntityId: string;
    let agentEntityId: string;
    if (binding) {
      roomIds = [binding.roomId];
      ownerEntityId = binding.audience.ownerEntityId;
      agentEntityId = binding.audience.agentEntityId;
    } else {
      if (
        typeof runtime.getRoomsForParticipants !== "function" ||
        typeof runtime.getParticipantsForRoom !== "function"
      ) {
        return undefined;
      }
      const resolvedOwnerEntityId = await resolveOwnerEntityId(runtime);
      if (!resolvedOwnerEntityId) return undefined;
      ownerEntityId = resolvedOwnerEntityId;
      agentEntityId = String(runtime.agentId);
      // Adapter semantics are a UNION across supplied participants, not an
      // intersection. Start from owner rooms, then retain only exact two-party
      // owner/agent rooms so group or unrelated agent rooms cannot bleed into
      // an owner-only scheduled message.
      const candidateRoomIds = await runtime.getRoomsForParticipants([
        ownerEntityId as never,
      ]);
      const directRoomIds = await Promise.all(
        candidateRoomIds.map(async (roomId) => {
          const participants = await runtime.getParticipantsForRoom(roomId);
          const participantIds = new Set(participants.map(String));
          return participantIds.size === 2 &&
            participantIds.has(ownerEntityId) &&
            participantIds.has(agentEntityId)
            ? String(roomId)
            : null;
        }),
      );
      roomIds = directRoomIds.filter(
        (roomId): roomId is string => roomId !== null,
      );
    }
    if (roomIds.length === 0) return undefined;
    const memories = await runtime.getMemoriesByRoomIds({
      tableName: "messages",
      roomIds: roomIds as never[],
      limit: RECENT_CONVERSATION_LIMIT * 2,
    });
    const lines = memories
      .slice()
      .sort(
        (left: Memory, right: Memory) =>
          Number(left.createdAt ?? 0) - Number(right.createdAt ?? 0),
      )
      .map((memory: Memory) => {
        const entityId = String(memory.entityId);
        if (entityId !== ownerEntityId && entityId !== agentEntityId) {
          return null;
        }
        const text =
          typeof memory.content.text === "string"
            ? memory.content.text.trim()
            : "";
        if (!text) return null;
        const speaker = entityId === agentEntityId ? "Assistant" : "Owner";
        return truncateWellFormed(
          toWellFormedUnicode(`${speaker}: ${text}`),
          RECENT_CONVERSATION_LINE_LIMIT,
        );
      })
      .filter((line: string | null): line is string => line !== null)
      .slice(-RECENT_CONVERSATION_LIMIT);
    return lines.length > 0 ? lines : undefined;
  } catch (error) {
    // error-policy:J4 recent conversation is optional tone context; requested
    // facts still resolve and the dispatch remains visibly usable without it.
    runtime.reportError("lifeops:scheduled-task:conversation-context", error, {
      taskId: record.taskId,
    });
    return undefined;
  }
}

/** Resolve requested data plus bounded owner-tone continuity signals. */
export async function resolveScheduledTaskDispatchContext(
  runtime: IAgentRuntime,
  record: ScheduledTaskDispatchRecord,
): Promise<ScheduledTaskResolvedContext | undefined> {
  const request = record.contextRequest;
  assertContextRequestWithinLimits(record);
  const recentConversation = await resolveRecentConversation(runtime, record);
  const resolved: ScheduledTaskResolvedContext = {
    ...(recentConversation ? { recentConversation } : {}),
  };

  if (typeof runtime.getTasks === "function") {
    try {
      const profile = await readActivityProfile(runtime);
      if (profile) {
        const firedAtMs = Date.parse(record.firedAtIso);
        const minutesSinceLastSeen =
          Number.isFinite(firedAtMs) && Number.isFinite(profile.lastSeenAt)
            ? Math.max(0, Math.floor((firedAtMs - profile.lastSeenAt) / 60_000))
            : undefined;
        resolved.activityPacing = {
          state: profile.isCurrentlySleeping
            ? "sleeping"
            : profile.isCurrentlyActive
              ? "active"
              : "quiet",
          ...(minutesSinceLastSeen !== undefined
            ? { minutesSinceLastSeen }
            : {}),
          ...(profile.lastSeenPlatform
            ? { lastSeenPlatform: profile.lastSeenPlatform }
            : {}),
        };
      }
    } catch (error) {
      // error-policy:J4 activity pacing is optional tone context; requested
      // task data still resolves and the dispatch remains usable without it.
      runtime.reportError("lifeops:scheduled-task:activity-context", error, {
        taskId: record.taskId,
      });
    }
  }

  if (!request) {
    return Object.keys(resolved).length > 0 ? resolved : undefined;
  }

  if (request.includeOwnerFacts?.length) {
    let view: OwnerFactsView;
    try {
      const facts = await resolveOwnerFactStore(runtime).read();
      view = ownerFactsToView(facts, new Date(record.firedAtIso));
    } catch (error) {
      // error-policy:J2 context-adding rethrow
      throw contextError(
        "Unable to resolve owner facts for scheduled dispatch.",
        "SCHEDULED_DISPATCH_OWNER_FACTS_UNAVAILABLE",
        record,
        error,
      );
    }
    const ownerFacts: NonNullable<ScheduledTaskResolvedContext["ownerFacts"]> =
      {};
    for (const key of request.includeOwnerFacts) {
      const value = view[key];
      if (value !== undefined) Object.assign(ownerFacts, { [key]: value });
    }
    if (Object.keys(ownerFacts).length > 0) resolved.ownerFacts = ownerFacts;
  }

  const graphRequest =
    request.includeEntities !== undefined ||
    request.includeRelationships !== undefined;
  const graph = graphRequest ? resolveKnowledgeGraphService(runtime) : null;
  if (graphRequest && !graph) {
    throw contextError(
      "Knowledge graph is unavailable for scheduled dispatch context.",
      "SCHEDULED_DISPATCH_GRAPH_UNAVAILABLE",
      record,
    );
  }

  if (request.includeEntities) {
    const store = graph?.getEntityStore(runtime.agentId);
    if (!store) {
      throw contextError(
        "Entity store is unavailable for scheduled dispatch context.",
        "SCHEDULED_DISPATCH_ENTITY_STORE_UNAVAILABLE",
        record,
      );
    }
    const fields = new Set(
      request.includeEntities.fields ?? ["preferredName", "type"],
    );
    const entities = await Promise.all(
      request.includeEntities.entityIds.map(async (entityId) => {
        const entity = await store.get(entityId);
        if (!entity) {
          throw contextError(
            `Entity ${entityId} is unavailable for scheduled dispatch context.`,
            "SCHEDULED_DISPATCH_ENTITY_NOT_FOUND",
            record,
          );
        }
        return {
          entityId,
          ...(fields.has("preferredName")
            ? { preferredName: entity.preferredName }
            : {}),
          ...(fields.has("type") ? { type: entity.type } : {}),
          ...(fields.has("identities")
            ? {
                identities: entity.identities.map((identity) => ({
                  platform: identity.platform,
                  handle: identity.handle,
                  ...(identity.displayName
                    ? { displayName: identity.displayName }
                    : {}),
                  verified: identity.verified,
                })),
              }
            : {}),
          ...(fields.has("state.lastInteractionPlatform") &&
          entity.state.lastInteractionPlatform
            ? {
                lastInteractionPlatform: entity.state.lastInteractionPlatform,
              }
            : {}),
        };
      }),
    );
    resolved.entities = entities;
  }

  if (request.includeRelationships) {
    if (
      !request.includeRelationships.relationshipIds?.length &&
      !request.includeRelationships.forEntityIds?.length &&
      !request.includeRelationships.types?.length
    ) {
      throw contextError(
        "Relationship context request has no scope filter.",
        "SCHEDULED_DISPATCH_RELATIONSHIP_SCOPE_REQUIRED",
        record,
      );
    }
    const store = graph?.getRelationshipStore(runtime.agentId);
    if (!store) {
      throw contextError(
        "Relationship store is unavailable for scheduled dispatch context.",
        "SCHEDULED_DISPATCH_RELATIONSHIP_STORE_UNAVAILABLE",
        record,
      );
    }
    const requestedIds = request.includeRelationships.relationshipIds;
    const candidates = requestedIds?.length
      ? await Promise.all(requestedIds.map((id) => store.get(id)))
      : await store.list({ limit: 100 });
    if (requestedIds?.length && candidates.some((value) => value === null)) {
      throw contextError(
        "A requested relationship is unavailable for scheduled dispatch context.",
        "SCHEDULED_DISPATCH_RELATIONSHIP_NOT_FOUND",
        record,
      );
    }
    const entityIds = new Set(request.includeRelationships.forEntityIds ?? []);
    const types = new Set(request.includeRelationships.types ?? []);
    resolved.relationships = candidates
      .filter((relationship) => relationship !== null)
      .filter(
        (relationship) =>
          entityIds.size === 0 ||
          entityIds.has(relationship.fromEntityId) ||
          entityIds.has(relationship.toEntityId),
      )
      .filter(
        (relationship) => types.size === 0 || types.has(relationship.type),
      )
      .map((relationship) => ({
        relationshipId: relationship.relationshipId,
        fromEntityId: relationship.fromEntityId,
        toEntityId: relationship.toEntityId,
        type: relationship.type,
        state: {
          ...(relationship.state.lastInteractionAt
            ? { lastInteractionAt: relationship.state.lastInteractionAt }
            : {}),
          ...(relationship.state.interactionCount !== undefined
            ? { interactionCount: relationship.state.interactionCount }
            : {}),
          ...(relationship.state.sentimentTrend
            ? { sentimentTrend: relationship.state.sentimentTrend }
            : {}),
        },
      }));
  }

  if (request.includeRecentTaskStates) {
    try {
      const requested = request.includeRecentTaskStates;
      resolved.recentTaskStates = await createRecentTaskStatesProvider(
        runtime,
      ).summarize({
        ...(requested.kind ? { kinds: [requested.kind] } : {}),
        lookbackDays: (requested.lookbackHours ?? 24 * 7) / 24,
        asOf: new Date(record.firedAtIso),
      });
    } catch (error) {
      // error-policy:J2 context-adding rethrow
      throw contextError(
        "Unable to resolve recent task states for scheduled dispatch.",
        "SCHEDULED_DISPATCH_TASK_STATES_UNAVAILABLE",
        record,
        error,
      );
    }
  }

  if (
    request.includeEventPayload === true &&
    Object.hasOwn(record, "eventPayload")
  ) {
    resolved.eventPayload = normalizeEventPayload(record.eventPayload);
  }

  return Object.keys(resolved).length > 0 ? resolved : undefined;
}
