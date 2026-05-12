import { describe, expect, it } from "vitest";
import { compactConversationAction } from "./compact-conversation.ts";

const ROOM_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const USER_ID = "55555555-5555-4555-8555-555555555555";

function makeRuntime(messageCount: number) {
  const room = {
    id: ROOM_ID,
    source: "test",
    type: "DM",
    metadata: {},
  };
  const memories = Array.from({ length: messageCount }, (_, index) => ({
    id: `mem-${index}`,
    entityId: index % 2 === 0 ? USER_ID : AGENT_ID,
    roomId: ROOM_ID,
    createdAt: 1_700_000_000_000 + index * 1000,
    content: {
      text:
        index === 0
          ? "remember parcel code LIME-4421"
          : `conversation turn ${index}`,
    },
  }));
  return {
    agentId: AGENT_ID,
    useModel: async () =>
      JSON.stringify({
        state: {
          facts: ["parcel code LIME-4421"],
          decisions: [],
          pending_actions: [],
          forbidden_behaviors: [],
          entities: { parcel: "LIME-4421" },
        },
        ledger: [{ index: 1, note: "user said parcel code LIME-4421" }],
      }),
    countMemories: async () => messageCount,
    getMemories: async () => memories,
    getRoom: async () => room,
    updateRoom: async (nextRoom: typeof room) => {
      Object.assign(room, nextRoom);
    },
    _room: room,
  };
}

function makePagedRuntime(messageCount: number) {
  const room = {
    id: ROOM_ID,
    source: "test",
    type: "DM",
    metadata: {},
  };
  const memories = Array.from({ length: messageCount }, (_, index) => ({
    id: `mem-${index}`,
    entityId: index % 2 === 0 ? USER_ID : AGENT_ID,
    roomId: ROOM_ID,
    createdAt: 1_700_000_000_000 + index * 1000,
    content: {
      text:
        index === 0
          ? "remember parcel code LIME-4421"
          : `conversation turn ${index}`,
    },
  }));
  return {
    agentId: AGENT_ID,
    useModel: async () =>
      JSON.stringify({
        state: {
          facts: ["parcel code LIME-4421"],
          decisions: [],
          pending_actions: [],
          forbidden_behaviors: [],
          entities: { parcel: "LIME-4421" },
        },
        ledger: [{ index: 1, note: "user said parcel code LIME-4421" }],
      }),
    countMemories: async () => messageCount,
    getMemories: async (params: { offset?: number; limit?: number }) => {
      const offset = params.offset ?? 0;
      const limit = params.limit ?? memories.length;
      return memories.slice(offset, offset + limit);
    },
    getRoom: async () => room,
    updateRoom: async (nextRoom: typeof room) => {
      Object.assign(room, nextRoom);
    },
    _room: room,
    _memories: memories,
  };
}

describe("compactConversationAction", () => {
  it("is unavailable for new sessions with too little history", async () => {
    const runtime = makeRuntime(2);
    const message = {
      entityId: USER_ID,
      roomId: ROOM_ID,
      content: { text: "compact this conversation" },
    };

    await expect(
      compactConversationAction.validate(runtime as never, message as never),
    ).resolves.toBe(false);
  });

  it("persists a room ledger and compaction point for existing sessions", async () => {
    const runtime = makeRuntime(20);
    const message = {
      entityId: USER_ID,
      roomId: ROOM_ID,
      content: { text: "compact this conversation" },
    };

    const result = await compactConversationAction.handler(
      runtime as never,
      message as never,
      undefined,
      undefined,
    );

    expect(result?.success).toBe(true);
    expect(result?.values?.compacted).toBe(true);
    const metadata = runtime._room.metadata as Record<string, unknown>;
    expect(metadata.lastCompactionAt).toBeTypeOf("number");
    expect(metadata.compactionHistory).toHaveLength(1);
    expect(
      (metadata.conversationCompaction as Record<string, unknown>).priorLedger,
    ).toContain("LIME-4421");
  });

  it("compacts the oldest fetched window in very long sessions", async () => {
    const runtime = makePagedRuntime(5050);
    const message = {
      entityId: USER_ID,
      roomId: ROOM_ID,
      content: { text: "compact this conversation" },
    };

    const result = await compactConversationAction.handler(
      runtime as never,
      message as never,
      undefined,
      undefined,
    );

    expect(result?.success).toBe(true);
    const metadata = runtime._room.metadata as Record<string, unknown>;
    const history = metadata.compactionHistory as Array<
      Record<string, unknown>
    >;
    expect(history[0]?.loadedMessageCount).toBe(5000);
    expect(history[0]?.completeMessageWindow).toBe(false);
    expect(metadata.lastCompactionAt).toBe(
      runtime._memories[4991].createdAt + 1,
    );
  });
});
