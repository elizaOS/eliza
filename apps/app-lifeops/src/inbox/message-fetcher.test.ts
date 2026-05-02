import {
  ChannelType,
  type IAgentRuntime,
  type Memory,
  type Room,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { fetchChatMessages } from "./message-fetcher.js";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;

function room(
  id: string,
  type: Room["type"] | string,
  name: string,
  metadata: Record<string, unknown> = {},
  source = "telegram",
): Room {
  return {
    id: id as UUID,
    name,
    source,
    type: type as Room["type"],
    metadata,
  } as Room;
}

function memory(
  id: string,
  roomId: string,
  text: string,
  createdAt: number,
  source = "telegram",
) {
  return {
    id: id as UUID,
    roomId: roomId as UUID,
    entityId: `00000000-0000-0000-0000-0000000001${id.slice(-2)}` as UUID,
    createdAt,
    content: {
      source,
      text,
    },
    metadata: {
      entityName: `Sender ${id}`,
    },
  } as Memory;
}

function runtimeFor(args: {
  rooms: Room[];
  memories: Memory[];
  participantCounts: Record<string, number>;
}): IAgentRuntime {
  const roomsById = new Map(args.rooms.map((item) => [item.id, item]));
  return {
    agentId: AGENT_ID,
    getRoomsForParticipant: vi.fn(async () =>
      args.rooms.map((item) => item.id),
    ),
    getRoom: vi.fn(async (id: UUID) => roomsById.get(id) ?? null),
    getWorld: vi.fn(async () => null),
    getParticipantsForRoom: vi.fn(async (id: UUID) =>
      Array.from({ length: args.participantCounts[id] ?? 0 }, (_, index) =>
        String(index),
      ),
    ),
    getMemoriesByRoomIds: vi.fn(async () => args.memories),
  } as unknown as IAgentRuntime;
}

describe("fetchChatMessages", () => {
  it("only classifies explicit one-to-one direct rooms as DMs", async () => {
    const rooms = [
      room("00000000-0000-0000-0000-000000000011", ChannelType.DM, "Alice"),
      room(
        "00000000-0000-0000-0000-000000000012",
        ChannelType.DM,
        "Planning group DM",
      ),
      room(
        "00000000-0000-0000-0000-000000000013",
        ChannelType.FEED,
        "Announcements",
      ),
      room(
        "00000000-0000-0000-0000-000000000014",
        "mystery-room",
        "Unknown room",
      ),
    ];
    const memories = [
      memory("00000000-0000-0000-0000-000000000101", rooms[0].id, "dm", 4),
      memory(
        "00000000-0000-0000-0000-000000000102",
        rooms[1].id,
        "group dm",
        3,
      ),
      memory(
        "00000000-0000-0000-0000-000000000103",
        rooms[2].id,
        "public feed",
        2,
      ),
      memory("00000000-0000-0000-0000-000000000104", rooms[3].id, "unknown", 1),
    ];

    const messages = await fetchChatMessages(
      runtimeFor({
        rooms,
        memories,
        participantCounts: {
          [rooms[0].id]: 2,
          [rooms[1].id]: 3,
          [rooms[2].id]: 50,
          [rooms[3].id]: 2,
        },
      }),
      { sources: ["telegram"], limit: 10 },
    );

    const byRoom = new Map(
      messages.map((message) => [message.roomId, message]),
    );
    expect(byRoom.get(rooms[0].id)?.chatType).toBe("dm");
    expect(byRoom.get(rooms[1].id)?.chatType).toBe("group");
    expect(byRoom.get(rooms[2].id)?.chatType).toBe("channel");
    expect(byRoom.get(rooms[3].id)?.chatType).toBe("channel");
  });

  it("includes connector-tagged rooms by default and normalizes source aliases before filtering", async () => {
    const rooms = [
      room(
        "00000000-0000-0000-0000-000000000021",
        ChannelType.DM,
        "Matrix DM",
        {},
        "Matrix",
      ),
      room(
        "00000000-0000-0000-0000-000000000022",
        ChannelType.DM,
        "Discord DM",
        {},
        "Discord",
      ),
    ];
    const messages = [
      memory(
        "00000000-0000-0000-0000-000000000201",
        rooms[0].id,
        "custom connector",
        2,
        "MATRIX",
      ),
      memory(
        "00000000-0000-0000-0000-000000000202",
        rooms[1].id,
        "discord alias",
        1,
        "DISCORD-LOCAL",
      ),
    ];

    const defaultMessages = await fetchChatMessages(
      runtimeFor({
        rooms,
        memories: messages,
        participantCounts: {
          [rooms[0].id]: 2,
          [rooms[1].id]: 2,
        },
      }),
      { limit: 10 },
    );
    expect(defaultMessages.map((message) => message.source).sort()).toEqual([
      "discord",
      "matrix",
    ]);

    const discordMessages = await fetchChatMessages(
      runtimeFor({
        rooms,
        memories: messages,
        participantCounts: {
          [rooms[0].id]: 2,
          [rooms[1].id]: 2,
        },
      }),
      { sources: ["discord"], limit: 10 },
    );
    expect(discordMessages.map((message) => message.source)).toEqual([
      "discord",
    ]);
  });
});
