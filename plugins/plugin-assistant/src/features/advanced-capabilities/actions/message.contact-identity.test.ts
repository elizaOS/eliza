/** Exercises exact contact selection and uncapped reads through MESSAGE with a deterministic relationship query and storage boundary. */
import { type Memory, stringToUuid, type UUID } from "@elizaos/core";
import { createMockRuntime } from "@elizaos/testing";
import { describe, expect, it, vi } from "vitest";
import { createNativeRelationshipsGraphService } from "../../../services/relationships-graph-builder.ts";
import { messageAction } from "./message.ts";

const targetId = stringToUuid("requested-contact");
const primaryId = stringToUuid("contact-primary");
const roomId = stringToUuid("contact-room");
const message = {
  id: stringToUuid("contact-request"),
  entityId: stringToUuid("requester"),
  agentId: stringToUuid("agent"),
  roomId,
  content: { text: "Read the requested contact" },
} as Memory;

function harness(includeTarget: boolean, linked: boolean, realGraph = false) {
  const people = Array.from({ length: 6 }, (_, index) => ({
    primaryEntityId: stringToUuid(`other-${index}`),
    memberEntityIds: [] as UUID[],
    displayName: `Reference to ${targetId}`,
    platforms: [],
    aliases: [targetId],
  }));
  if (includeTarget)
    people.push({
      primaryEntityId: linked ? primaryId : targetId,
      memberEntityIds: linked ? [targetId] : [],
      displayName: "Requested contact",
      platforms: [],
      aliases: [],
    });
  let graph:
    | ReturnType<typeof createNativeRelationshipsGraphService>
    | undefined;
  const getGraphSnapshot = vi.fn(
    async (query: { search?: string; limit?: number }) =>
      graph
        ? graph.getGraphSnapshot(query)
        : {
            people:
              query.limit === undefined ? people : people.slice(0, query.limit),
          },
  );
  const getRoomsForParticipant = vi.fn(async (_entityId: UUID) => [roomId]);
  const getMemories = vi.fn(async (query: { count?: number }) => {
    const rows = Array.from({ length: 250 }, (_, index) => ({
      ...message,
      id: stringToUuid(`contact-history-${index}`),
      createdAt: index + 1,
      content: { text: `Message ${index}` },
    }));
    return query.count === undefined ? rows : rows.slice(0, query.count);
  });
  const runtime = createMockRuntime({
    getService: () => ({ getGraphSnapshot }) as never,
    getRoomsForParticipant,
    getRoom: async () =>
      ({ id: roomId, source: "discord", name: "Contact" }) as never,
    getMemories,
    getAllWorlds: async () => [],
    getRoomsByWorlds: async () => [],
    getRelationships: async () => [],
    getEntityById: async (id: UUID) => {
      const person = people.find(
        (candidate) => candidate.primaryEntityId === id,
      );
      return person ? { id, names: [person.displayName], metadata: {} } : null;
    },
  });
  if (realGraph)
    graph = createNativeRelationshipsGraphService(runtime, {
      searchContacts: async () =>
        people.map((person) => ({ entityId: person.primaryEntityId })),
    });
  const read = () =>
    messageAction.handler(runtime, message, undefined, {
      parameters: { action: "read_with_contact", entityId: targetId },
    });
  return { read, getRoomsForParticipant, getMemories };
}

describe("MESSAGE explicit contact identity", () => {
  it("uses the real relationship graph to resolve the exact identity among name matches", async () => {
    const { read, getRoomsForParticipant } = harness(true, false, true);
    const result = await read();
    expect(result?.success).toBe(true);
    expect(result?.data).toMatchObject({
      primaryEntityId: targetId,
      totalMessages: 250,
    });
    expect(getRoomsForParticipant.mock.calls.map(([id]) => id)).toEqual([
      targetId,
    ]);
  });
  it.each([false, true])(
    "finds the exact identity beyond five alias matches (linked=%s)",
    async (linked) => {
      const { read, getRoomsForParticipant } = harness(true, linked);
      const result = await read();
      expect(result?.success).toBe(true);
      expect(result?.data).toMatchObject({
        primaryEntityId: linked ? primaryId : targetId,
        totalMessages: 250,
      });
      expect(getRoomsForParticipant.mock.calls.map(([id]) => id)).toEqual(
        linked ? [primaryId, targetId] : [targetId],
      );
    },
  );

  it("does not read another person's rooms when the explicit identity is absent", async () => {
    const { read, getRoomsForParticipant, getMemories } = harness(false, false);
    const result = await read();
    expect(result?.success).toBe(false);
    expect(result?.data?.error).toBe("CONTACT_NOT_FOUND");
    expect(getRoomsForParticipant).not.toHaveBeenCalled();
    expect(getMemories).not.toHaveBeenCalled();
  });
});
