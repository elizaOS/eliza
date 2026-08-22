/**
 * Exercises per-fire ScheduledTask context resolution against typed store
 * fakes, including field minimization, event payloads, and bound-room dialogue.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import type { ScheduledTaskDispatchRecord } from "@elizaos/plugin-scheduling";
import { describe, expect, it, vi } from "vitest";
import {
  type OwnerFactStore,
  registerOwnerFactStore,
} from "../owner/fact-store.js";
import { resolveScheduledTaskDispatchContext } from "./dispatch-context.js";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const OWNER_ID = "00000000-0000-0000-0000-000000000002";
const ROOM_ID = "00000000-0000-0000-0000-000000000003";

function makeRecord(): ScheduledTaskDispatchRecord {
  return {
    taskId: "context-task",
    kind: "followup",
    firedAtIso: "2026-08-09T15:00:00.000Z",
    channelKey: "telegram",
    intensity: "normal",
    promptInstructions: "Ask whether Sam wants to reconnect with Pat.",
    contextRequest: {
      includeOwnerFacts: ["preferredName", "timezone"],
      includeEntities: {
        entityIds: ["pat"],
        fields: ["preferredName", "state.lastInteractionPlatform"],
      },
      includeRelationships: {
        relationshipIds: ["rel-pat"],
        forEntityIds: ["pat"],
        types: ["friend_of"],
      },
      includeRecentTaskStates: { kind: "followup", lookbackHours: 48 },
      includeEventPayload: true,
    },
    ownerVisible: true,
    eventPayload: { reason: "cadence_due" },
    metadata: {
      chatDeliveryBinding: {
        version: 1,
        source: "telegram",
        roomId: ROOM_ID,
        channelId: "owner-chat",
        audience: {
          kind: "direct",
          provenance: "canonical_room",
          ownerEntityId: OWNER_ID,
          agentEntityId: AGENT_ID,
          participantEntityIds: [AGENT_ID, OWNER_ID],
          membershipVersion: JSON.stringify([AGENT_ID, OWNER_ID].sort()),
        },
      },
    },
  };
}

function makeMemory(entityId: string, text: string, createdAt: number): Memory {
  return {
    id: crypto.randomUUID(),
    agentId: AGENT_ID,
    entityId,
    roomId: ROOM_ID,
    createdAt,
    content: { text },
  } as Memory;
}

function makeRuntime(): IAgentRuntime {
  const graph = {
    getEntityStore: () => ({
      get: async (entityId: string) =>
        entityId === "pat"
          ? {
              entityId,
              type: "person",
              preferredName: "Pat",
              fullName: "Pat Private-Full-Name",
              identities: [
                {
                  platform: "telegram",
                  handle: "private-handle",
                  verified: true,
                  confidence: 1,
                  addedAt: "2026-01-01T00:00:00.000Z",
                  addedVia: "manual",
                  evidence: [],
                },
              ],
              attributes: {
                privateNote: {
                  value: "must not leak",
                  confidence: 1,
                  evidence: [],
                  updatedAt: "2026-01-01T00:00:00.000Z",
                },
              },
              state: { lastInteractionPlatform: "whatsapp" },
              tags: [],
              visibility: "owner_only",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-08-01T00:00:00.000Z",
            }
          : null,
    }),
    getRelationshipStore: () => ({
      get: async (relationshipId: string) =>
        relationshipId === "rel-pat"
          ? {
              relationshipId,
              fromEntityId: "self",
              toEntityId: "pat",
              type: "friend_of",
              metadata: { privateNote: "must not leak" },
              state: {
                lastInteractionAt: "2026-07-01T00:00:00.000Z",
                interactionCount: 4,
              },
              evidence: ["private evidence"],
              confidence: 1,
              source: "manual",
              status: "active",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-07-01T00:00:00.000Z",
            }
          : null,
      list: async () => [],
    }),
  };
  const taskLog = [
    {
      taskId: "older-followup",
      kind: "followup",
      outcome: "completed",
      recordedAt: "2026-08-08T14:00:00.000Z",
    },
  ];
  return {
    agentId: AGENT_ID,
    character: { name: "Eliza" },
    getSetting: (key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER_ID : null,
    getService: (type: string) =>
      type === "eliza_knowledge_graph" ? graph : null,
    getMemoriesByRoomIds: vi.fn(async () => [
      makeMemory(OWNER_ID, "Pat has been on my mind.", 1),
      makeMemory(
        "00000000-0000-0000-0000-000000000099",
        "third-party group content must not cross the boundary",
        2,
      ),
      makeMemory(AGENT_ID, "We can keep it low pressure.", 3),
    ]),
    getCache: vi.fn(async (key: string) =>
      key === "eliza:lifeops:scheduled-task-log:v1" ? taskLog : undefined,
    ),
    setCache: vi.fn(async () => undefined),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
}

describe("resolveScheduledTaskDispatchContext", () => {
  it("resolves requested fields at fire time without leaking unrequested data", async () => {
    const runtime = makeRuntime();
    registerOwnerFactStore(runtime, {
      read: async () => ({
        preferredName: {
          value: "Sam",
          provenance: { source: "user", updatedAt: "2026-01-01" },
        },
        timezone: {
          value: "America/Los_Angeles",
          provenance: { source: "user", updatedAt: "2026-01-01" },
        },
        locale: {
          value: "en-US",
          provenance: { source: "user", updatedAt: "2026-01-01" },
        },
      }),
    } as unknown as OwnerFactStore);

    const context = await resolveScheduledTaskDispatchContext(
      runtime,
      makeRecord(),
    );

    expect(context?.ownerFacts).toEqual({
      preferredName: "Sam",
      timezone: "America/Los_Angeles",
    });
    expect(context?.entities).toEqual([
      {
        entityId: "pat",
        preferredName: "Pat",
        lastInteractionPlatform: "whatsapp",
      },
    ]);
    expect(context?.relationships).toEqual([
      {
        relationshipId: "rel-pat",
        fromEntityId: "self",
        toEntityId: "pat",
        type: "friend_of",
        state: {
          lastInteractionAt: "2026-07-01T00:00:00.000Z",
          interactionCount: 4,
        },
      },
    ]);
    expect(context?.recentTaskStates?.summary).toContain("followup: 1 done");
    expect(context?.eventPayload).toEqual({ reason: "cadence_due" });
    expect(context?.recentConversation).toEqual([
      "Owner: Pat has been on my mind.",
      "Assistant: We can keep it low pressure.",
    ]);
    expect(JSON.stringify(context)).not.toContain("must not leak");
    expect(JSON.stringify(context)).not.toContain("private-handle");
    expect(JSON.stringify(context)).not.toContain("third-party group content");
  });

  it("reads tone context only from exact owner-agent rooms and adds bounded activity pacing", async () => {
    const runtime = makeRuntime();
    const ownerEntityId = OWNER_ID;
    const directRoomId = "00000000-0000-0000-0000-000000000010";
    const groupRoomId = "00000000-0000-0000-0000-000000000011";
    const ownerOnlyRoomId = "00000000-0000-0000-0000-000000000012";
    const roomLookupEntityIds: string[] = [];
    runtime.getRoomsForParticipant = vi.fn(async () => []);
    runtime.getRoomsForParticipants = vi.fn(async (entityIds) => {
      roomLookupEntityIds.push(String(entityIds[0]));
      return [directRoomId, groupRoomId, ownerOnlyRoomId] as never[];
    });
    runtime.getParticipantsForRoom = vi.fn(async (roomId) => {
      if (String(roomId) === directRoomId) {
        return [ownerEntityId, AGENT_ID] as never[];
      }
      if (String(roomId) === groupRoomId) {
        return [ownerEntityId, AGENT_ID, "third-party"] as never[];
      }
      return [ownerEntityId] as never[];
    });
    runtime.getMemoriesByRoomIds = vi.fn(async () => [
      makeMemory(ownerEntityId, "Keep today calm.", 1),
      makeMemory(AGENT_ID, "I will keep it brief.", 2),
    ]);
    runtime.getTasks = vi.fn(
      async () =>
        [
          {
            name: "PROACTIVE_AGENT",
            metadata: {
              activityProfile: {
                ownerEntityId,
                analyzedAt: Date.parse("2026-08-09T14:50:00.000Z"),
                totalMessages: 12,
                lastSeenAt: Date.parse("2026-08-09T14:45:00.000Z"),
                lastSeenPlatform: "telegram",
                isCurrentlySleeping: false,
                isCurrentlyActive: false,
              },
            },
          },
        ] as never[],
    );
    const record = makeRecord();
    record.metadata = undefined;
    record.contextRequest = undefined;

    const context = await resolveScheduledTaskDispatchContext(runtime, record);

    expect(roomLookupEntityIds).toContain(ownerEntityId);
    expect(runtime.getMemoriesByRoomIds).toHaveBeenCalledWith(
      expect.objectContaining({ roomIds: [directRoomId] }),
    );
    expect(context).toEqual({
      recentConversation: [
        "Owner: Keep today calm.",
        "Assistant: I will keep it brief.",
      ],
      activityPacing: {
        state: "quiet",
        minutesSinceLastSeen: 15,
        lastSeenPlatform: "telegram",
      },
    });
  });

  it("fails closed when explicitly requested graph data is unavailable", async () => {
    const runtime = makeRuntime();
    const record = makeRecord();
    if (!record.contextRequest?.includeEntities) throw new Error("fixture");
    record.contextRequest.includeEntities.entityIds = ["missing"];
    await expect(
      resolveScheduledTaskDispatchContext(runtime, record),
    ).rejects.toMatchObject({ code: "SCHEDULED_DISPATCH_ENTITY_NOT_FOUND" });
  });

  it("rejects oversized context lookups before touching data stores", async () => {
    const runtime = makeRuntime();
    const record = makeRecord();
    if (!record.contextRequest?.includeEntities) throw new Error("fixture");
    record.contextRequest.includeEntities.entityIds = Array.from(
      { length: 101 },
      (_, index) => `entity-${index}`,
    );

    await expect(
      resolveScheduledTaskDispatchContext(runtime, record),
    ).rejects.toMatchObject({
      code: "SCHEDULED_DISPATCH_CONTEXT_LIMIT_EXCEEDED",
    });
    expect(runtime.getMemoriesByRoomIds).not.toHaveBeenCalled();
  });
});
