/**
 * fetchChatMessages must count the caller's limit against inbox candidates.
 * A raw window of limit*3 that is filled by the agent's own replies, or a
 * newer blank text that is discarded after the cut, used to hide older user
 * messages. The store stub honors limit and offset so a missing second page
 * fails the test. Deterministic harness: stubbed runtime and in-memory rows,
 * no database or network.
 */
import type { IAgentRuntime, Memory, Room, UUID } from "@elizaos/core";
import { ChannelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { fetchChatMessages } from "./message-fetcher.js";

const AGENT = "11111111-1111-4111-8111-111111111111" as UUID;
const USER = "22222222-2222-4222-8222-222222222222" as UUID;
const ROOM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;

function memory(
  id: string,
  createdAt: number,
  text: string,
  entityId: UUID = USER,
): Memory {
  return {
    id: id as UUID,
    agentId: AGENT,
    entityId,
    roomId: ROOM,
    createdAt,
    content: { text, source: "discord" },
    metadata: { type: "message", entityName: "Ada" },
  };
}

function runtimeFor(stored: Memory[]) {
  const reads: Array<{ limit?: number; offset?: number }> = [];
  const room: Room = {
    id: ROOM,
    name: "general",
    source: "discord",
    type: ChannelType.GROUP,
    channelId: "100",
    serverId: "200",
  };
  const runtime = {
    agentId: AGENT,
    getRoomsForParticipant: async () => [ROOM],
    getRoomsByIds: async () => [room],
    getMemoriesByRoomIds: async (params: {
      limit?: number;
      offset?: number;
    }) => {
      reads.push({ limit: params.limit, offset: params.offset });
      const offset = params.offset ?? 0;
      const limit = params.limit ?? stored.length;
      return stored.slice(offset, offset + limit);
    },
    getParticipantsForRooms: async (ids: UUID[]) =>
      ids.map((roomId) => ({ roomId, entityIds: [AGENT, USER] })),
    getWorldsByIds: async () => [],
  } as unknown as IAgentRuntime;
  return { runtime, reads };
}

describe("fetchChatMessages candidate window", () => {
  it("pages past the agent's own replies to fill the requested limit", async () => {
    const stored = [
      ...Array.from({ length: 6 }, (_, index) =>
        memory(`agent-${index}`, 1_000 - index, `agent reply ${index}`, AGENT),
      ),
      memory("user-new", 900, "please look at this"),
      memory("user-old", 800, "and this too"),
    ];
    const { runtime, reads } = runtimeFor(stored);

    const messages = await fetchChatMessages(runtime, { limit: 2 });

    expect(messages.map((message) => message.text)).toEqual([
      "please look at this",
      "and this too",
    ]);
    expect(reads).toEqual([
      { limit: 6, offset: 0 },
      { limit: 6, offset: 6 },
    ]);
  });

  it("has no page cap: fills the limit past ten pages of agent replies", async () => {
    const stored = [
      ...Array.from({ length: 66 }, (_, index) =>
        memory(`agent-${index}`, 2_000 - index, `agent reply ${index}`, AGENT),
      ),
      memory("user-below-cap", 1_900, "reached on the eleventh page"),
      memory("user-oldest", 1_800, "oldest ask"),
    ];
    const { runtime, reads } = runtimeFor(stored);

    const messages = await fetchChatMessages(runtime, { limit: 2 });

    expect(messages.map((message) => message.text)).toEqual([
      "reached on the eleventh page",
      "oldest ask",
    ]);
    expect(reads.length).toEqual(12);
  });

  it("does not let a newer blank message consume the result limit", async () => {
    const stored = [
      memory("blank", 1_000, ""),
      memory("visible", 900, "the actual ask"),
    ];
    const { runtime, reads } = runtimeFor(stored);

    const messages = await fetchChatMessages(runtime, { limit: 1 });

    expect(messages.map((message) => message.text)).toEqual(["the actual ask"]);
    expect(reads).toEqual([{ limit: 3, offset: 0 }]);
  });

  it("stops after the first page when that page already holds enough user messages", async () => {
    const stored = [
      memory("newest", 1_000, "newest"),
      memory("older", 900, "older"),
    ];
    const { runtime, reads } = runtimeFor(stored);

    const messages = await fetchChatMessages(runtime, { limit: 2 });

    expect(messages.map((message) => message.id)).toEqual(["newest", "older"]);
    expect(reads).toEqual([{ limit: 6, offset: 0 }]);
  });

  it("stops when a repeated page shows the store ignored offset", async () => {
    const page = Array.from({ length: 6 }, (_, index) =>
      memory(`agent-${index}`, 1_000 - index, `agent reply ${index}`, AGENT),
    );
    const reads: Array<{ limit?: number; offset?: number }> = [];
    const room: Room = {
      id: ROOM,
      name: "general",
      source: "discord",
      type: ChannelType.GROUP,
      channelId: "100",
      serverId: "200",
    };
    const runtime = {
      agentId: AGENT,
      getRoomsForParticipant: async () => [ROOM],
      getRoomsByIds: async () => [room],
      getMemoriesByRoomIds: async (params: {
        limit?: number;
        offset?: number;
      }) => {
        reads.push({ limit: params.limit, offset: params.offset });
        return page;
      },
      getParticipantsForRooms: async (ids: UUID[]) =>
        ids.map((roomId) => ({ roomId, entityIds: [AGENT, USER] })),
      getWorldsByIds: async () => [],
    } as unknown as IAgentRuntime;

    const messages = await fetchChatMessages(runtime, { limit: 2 });

    expect(messages).toEqual([]);
    expect(reads).toEqual([
      { limit: 6, offset: 0 },
      { limit: 6, offset: 6 },
    ]);
  });

  it("stops after one read when history is entirely older than sinceIso", async () => {
    const now = Date.now();
    const stored = Array.from({ length: 6 }, (_, index) =>
      memory(`old-${index}`, now - 86_400_000 - index, `old message ${index}`),
    );
    const { runtime, reads } = runtimeFor(stored);

    const messages = await fetchChatMessages(runtime, {
      limit: 2,
      sinceIso: new Date(now - 3_600_000).toISOString(),
    });

    expect(messages).toEqual([]);
    expect(reads).toEqual([{ limit: 6, offset: 0 }]);
  });

  it("stops when an offset-ignoring store repeats rows without ids", async () => {
    const page = Array.from({ length: 6 }, (_, index) => {
      const row = memory(
        `agent-${index}`,
        1_000 - index,
        `agent reply ${index}`,
        AGENT,
      );
      delete (row as { id?: unknown }).id;
      return row;
    });
    const reads: Array<{ limit?: number; offset?: number }> = [];
    const room: Room = {
      id: ROOM,
      name: "general",
      source: "discord",
      type: ChannelType.GROUP,
      channelId: "100",
      serverId: "200",
    };
    const runtime = {
      agentId: AGENT,
      getRoomsForParticipant: async () => [ROOM],
      getRoomsByIds: async () => [room],
      getMemoriesByRoomIds: async (params: {
        limit?: number;
        offset?: number;
      }) => {
        reads.push({ limit: params.limit, offset: params.offset });
        return page;
      },
      getParticipantsForRooms: async (ids: UUID[]) =>
        ids.map((roomId) => ({ roomId, entityIds: [AGENT, USER] })),
      getWorldsByIds: async () => [],
    } as unknown as IAgentRuntime;

    const messages = await fetchChatMessages(runtime, { limit: 2 });

    expect(messages).toEqual([]);
    expect(reads).toEqual([
      { limit: 6, offset: 0 },
      { limit: 6, offset: 6 },
    ]);
  });
});
