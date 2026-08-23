/**
 * Deterministic coverage for conversationProximityProvider. The provider is
 * real; getMemories is an in-memory fixture so aggregation, exclusion, sorting,
 * empty-window, and text formatting can be asserted without a database.
 */

import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { conversationProximityProvider } from "./conversation-proximity.ts";

const EMPTY_STATE: State = { values: {}, data: {}, text: "" };

const ROOM_ID = "00000000-0000-4000-8000-0000000000aa" as UUID;
const SENDER_ID = "00000000-0000-4000-8000-0000000000bb" as UUID;
const AGENT_ID = "00000000-0000-4000-8000-0000000000cc" as UUID;
const ALICE_ID = "00000000-0000-4000-8000-0000000000a1" as UUID;
const BOB_ID = "00000000-0000-4000-8000-0000000000b1" as UUID;
const CAROL_ID = "00000000-0000-4000-8000-0000000000c1" as UUID;

function message(overrides: {
  id?: UUID;
  entityId?: UUID;
  roomId?: UUID;
  createdAt?: number;
}): Memory {
  return {
    id: overrides.id ?? ("00000000-0000-4000-8000-000000000001" as UUID),
    entityId: overrides.entityId ?? SENDER_ID,
    roomId: overrides.roomId ?? ROOM_ID,
    content: { text: "hello" },
    createdAt: overrides.createdAt,
  } as Memory;
}

function runtimeWithMemories(
  memories: Memory[],
  captured: { query?: unknown } = {},
): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    getMemories: async (query: unknown) => {
      captured.query = query;
      return memories;
    },
  } as unknown as IAgentRuntime;
}

describe("conversationProximityProvider", () => {
  it("declares turn-scoped metadata used by provider routing", () => {
    expect(conversationProximityProvider.name).toBe("CONVERSATION_PROXIMITY");
    expect(conversationProximityProvider.description).toBe(
      "Recent co-participants in the current room with message counts and last-seen timestamps.",
    );
    expect(conversationProximityProvider.dynamic).toBe(true);
    expect(conversationProximityProvider.position).toBe(40);
    expect(conversationProximityProvider.cacheStable).toBe(false);
    expect(conversationProximityProvider.cacheScope).toBe("turn");
  });

  it("returns empty context when the sender entity is missing", async () => {
    const captured: { query?: unknown } = {};
    const runtime = runtimeWithMemories(
      [message({ entityId: ALICE_ID, createdAt: 10 })],
      captured,
    );
    const inbound = {
      id: "00000000-0000-4000-8000-000000000002" as UUID,
      roomId: ROOM_ID,
      content: { text: "hi" },
    } as Memory;

    const result = await conversationProximityProvider.get(
      runtime,
      inbound,
      EMPTY_STATE,
    );

    expect(captured.query).toBeUndefined();
    expect(result).toEqual({ text: "", values: {}, data: {} });
  });

  it("returns empty context when the room is missing", async () => {
    const captured: { query?: unknown } = {};
    const runtime = runtimeWithMemories(
      [message({ entityId: ALICE_ID, createdAt: 10 })],
      captured,
    );
    const inbound = {
      id: "00000000-0000-4000-8000-000000000003" as UUID,
      entityId: SENDER_ID,
      content: { text: "hi" },
    } as Memory;

    const result = await conversationProximityProvider.get(
      runtime,
      inbound,
      EMPTY_STATE,
    );

    expect(captured.query).toBeUndefined();
    expect(result).toEqual({ text: "", values: {}, data: {} });
  });

  it("returns empty text for an empty recent-message window", async () => {
    const captured: { query?: unknown } = {};
    const runtime = runtimeWithMemories([], captured);

    const result = await conversationProximityProvider.get(
      runtime,
      message({ entityId: SENDER_ID, roomId: ROOM_ID }),
      EMPTY_STATE,
    );

    expect(captured.query).toEqual({
      roomId: ROOM_ID,
      tableName: "messages",
      limit: 20,
      unique: false,
    });
    expect(result.text).toBe("");
    expect(result.values).toEqual({ conversationProximityParticipants: [] });
    expect(result.data).toEqual({ coParticipants: [] });
  });

  it("skips memories without an entity, the sender, and the agent itself", async () => {
    const runtime = runtimeWithMemories([
      {
        id: "00000000-0000-4000-8000-000000000010" as UUID,
        roomId: ROOM_ID,
        content: { text: "hello" },
        createdAt: 30,
      } as Memory,
      message({
        id: "00000000-0000-4000-8000-000000000011" as UUID,
        entityId: SENDER_ID,
        createdAt: 40,
      }),
      message({
        id: "00000000-0000-4000-8000-000000000012" as UUID,
        entityId: AGENT_ID,
        createdAt: 50,
      }),
      message({
        id: "00000000-0000-4000-8000-000000000013" as UUID,
        entityId: ALICE_ID,
        createdAt: 20,
      }),
    ]);

    const result = await conversationProximityProvider.get(
      runtime,
      message({ entityId: SENDER_ID }),
      EMPTY_STATE,
    );

    expect(result.values?.conversationProximityParticipants).toEqual([
      { entityId: ALICE_ID, lastSeen: 20, messageCount: 1 },
    ]);
    expect(result.data?.coParticipants).toEqual(
      result.values?.conversationProximityParticipants,
    );
    expect(result.text).toBe(
      `Conversation proximity:\n- ${ALICE_ID}: 1 recent messages, last seen 20`,
    );
  });

  it("aggregates a single co-participant across repeats and missing createdAt", async () => {
    const runtime = runtimeWithMemories([
      message({
        id: "00000000-0000-4000-8000-000000000020" as UUID,
        entityId: ALICE_ID,
      }),
      message({
        id: "00000000-0000-4000-8000-000000000021" as UUID,
        entityId: ALICE_ID,
        createdAt: 7,
      }),
      message({
        id: "00000000-0000-4000-8000-000000000022" as UUID,
        entityId: ALICE_ID,
        createdAt: 3,
      }),
    ]);

    const result = await conversationProximityProvider.get(
      runtime,
      message({ entityId: SENDER_ID }),
      EMPTY_STATE,
    );

    expect(result.values?.conversationProximityParticipants).toEqual([
      { entityId: ALICE_ID, lastSeen: 7, messageCount: 3 },
    ]);
  });

  it("orders co-participants most-recent first", async () => {
    const runtime = runtimeWithMemories([
      message({
        id: "00000000-0000-4000-8000-000000000030" as UUID,
        entityId: ALICE_ID,
        createdAt: 10,
      }),
      message({
        id: "00000000-0000-4000-8000-000000000031" as UUID,
        entityId: BOB_ID,
        createdAt: 30,
      }),
      message({
        id: "00000000-0000-4000-8000-000000000032" as UUID,
        entityId: CAROL_ID,
        createdAt: 20,
      }),
    ]);

    const result = await conversationProximityProvider.get(
      runtime,
      message({ entityId: SENDER_ID }),
      EMPTY_STATE,
    );

    expect(result.data?.coParticipants).toEqual([
      { entityId: BOB_ID, lastSeen: 30, messageCount: 1 },
      { entityId: CAROL_ID, lastSeen: 20, messageCount: 1 },
      { entityId: ALICE_ID, lastSeen: 10, messageCount: 1 },
    ]);
  });

  it("breaks lastSeen ties by message count descending", async () => {
    const runtime = runtimeWithMemories([
      message({
        id: "00000000-0000-4000-8000-000000000040" as UUID,
        entityId: ALICE_ID,
        createdAt: 100,
      }),
      message({
        id: "00000000-0000-4000-8000-000000000041" as UUID,
        entityId: BOB_ID,
        createdAt: 100,
      }),
      message({
        id: "00000000-0000-4000-8000-000000000042" as UUID,
        entityId: BOB_ID,
        createdAt: 50,
      }),
    ]);

    const result = await conversationProximityProvider.get(
      runtime,
      message({ entityId: SENDER_ID }),
      EMPTY_STATE,
    );

    expect(result.values?.conversationProximityParticipants).toEqual([
      { entityId: BOB_ID, lastSeen: 100, messageCount: 2 },
      { entityId: ALICE_ID, lastSeen: 100, messageCount: 1 },
    ]);
  });

  it("breaks lastSeen and count ties with entityId localeCompare", async () => {
    const runtime = runtimeWithMemories([
      message({
        id: "00000000-0000-4000-8000-000000000050" as UUID,
        entityId: BOB_ID,
        createdAt: 5,
      }),
      message({
        id: "00000000-0000-4000-8000-000000000051" as UUID,
        entityId: ALICE_ID,
        createdAt: 5,
      }),
    ]);

    const result = await conversationProximityProvider.get(
      runtime,
      message({ entityId: SENDER_ID }),
      EMPTY_STATE,
    );

    expect(result.data?.coParticipants).toEqual([
      { entityId: ALICE_ID, lastSeen: 5, messageCount: 1 },
      { entityId: BOB_ID, lastSeen: 5, messageCount: 1 },
    ]);
    expect(ALICE_ID.localeCompare(BOB_ID)).toBeLessThan(0);
  });

  it("processes every memory the query returns rather than applying a second cap", async () => {
    const overflow = Array.from({ length: 21 }, (_, index) =>
      message({
        id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}` as UUID,
        entityId: ALICE_ID,
        createdAt: index + 1,
      }),
    );
    const captured: { query?: unknown } = {};
    const runtime = runtimeWithMemories(overflow, captured);

    const result = await conversationProximityProvider.get(
      runtime,
      message({ entityId: SENDER_ID }),
      EMPTY_STATE,
    );

    expect(captured.query).toEqual({
      roomId: ROOM_ID,
      tableName: "messages",
      limit: 20,
      unique: false,
    });
    expect(result.values?.conversationProximityParticipants).toEqual([
      { entityId: ALICE_ID, lastSeen: 21, messageCount: 21 },
    ]);
  });
});
