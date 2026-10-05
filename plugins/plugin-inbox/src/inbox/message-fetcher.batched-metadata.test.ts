/**
 * Exercises complete chat-feed projection with deterministic database collaborators.
 * Shuffled batch rows must preserve world links, participant-based classification,
 * recency, and explicit limits; failed reads must reject the feed.
 */
import { randomUUID } from "node:crypto";
import {
  ChannelType,
  type IAgentRuntime,
  type Memory,
  type Room,
  type UUID,
  type World,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { fetchChatMessages } from "./message-fetcher.js";

function fixture() {
  const agentId = randomUUID() as UUID;
  const sender = randomUUID() as UUID;
  const worldIds = Array.from({ length: 3 }, () => randomUUID() as UUID);
  const rooms: Room[] = worldIds.map((worldId, index) => ({
    id: randomUUID() as UUID,
    worldId,
    name: `Conversation ${index}`,
    source: "discord",
    type: ChannelType.DM,
    metadata: { channelId: `channel-${index}` },
  }));
  const worlds: World[] = worldIds.slice(0, 2).map((id, index) => ({
    id,
    agentId,
    name: `World ${index}`,
    metadata: { serverId: `guild-${index}` },
  }));
  const participants = rooms.map((room, index) => ({
    roomId: room.id,
    entityIds:
      index === 0
        ? [agentId, sender]
        : index === 1
          ? [agentId, sender, randomUUID() as UUID]
          : [],
  }));
  const memories: Memory[] = rooms.map((room, index) => ({
    id: randomUUID() as UUID,
    agentId,
    entityId: sender,
    roomId: room.id,
    createdAt: [200, 300, 100][index],
    content: {
      text: `Complete message ${index} with final detail`,
      source: "discord",
    },
  }));
  const calls = {
    worlds: [] as UUID[][],
    participants: [] as UUID[][],
    singleWorlds: 0,
    singleParticipants: 0,
  };
  const methods = {
    agentId,
    getRoomsForParticipant: async () => rooms.map((room) => room.id),
    getRoomsByIds: async () => [...rooms].reverse(),
    getMemoriesByRoomIds: async () => memories,
    getWorld: async (id: UUID) => {
      calls.singleWorlds++;
      return worlds.find((world) => world.id === id) ?? null;
    },
    getWorldsByIds: async (ids: UUID[]) => {
      calls.worlds.push([...ids]);
      return [...worlds].reverse();
    },
    getParticipantsForRoom: async (id: UUID) => {
      calls.singleParticipants++;
      return participants.find((row) => row.roomId === id)?.entityIds ?? [];
    },
    getParticipantsForRooms: async (ids: UUID[]) => {
      calls.participants.push([...ids]);
      return [...participants].reverse();
    },
  };
  return {
    methods,
    runtime: methods as unknown as IAgentRuntime,
    rooms,
    memories,
    worldIds,
    calls,
  };
}

describe("chat feed batched metadata", () => {
  it.each([2, 3])(
    "preserves links, classification, and recency with explicit limit %i",
    async (limit) => {
      const f = fixture();
      const result = await fetchChatMessages(f.runtime, { limit });
      const order = [1, 0, 2].slice(0, limit);
      expect(result.map((message) => message.id)).toEqual(
        order.map((index) => f.memories[index].id),
      );
      expect(result.map((message) => message.text)).toEqual(
        order.map((index) => f.memories[index].content.text),
      );
      expect(result.map((message) => message.channelName)).toEqual(
        order.map((index) => f.rooms[index].name),
      );
      expect(result.map((message) => message.chatType)).toEqual(
        ["group", "dm", "dm"].slice(0, limit),
      );
      expect(result.map((message) => message.deepLink)).toEqual(
        order.map(
          (index) =>
            `https://discord.com/channels/${index === 2 ? "@me" : `guild-${index}`}/channel-${index}/${f.memories[index].id}`,
        ),
      );
      expect(f.calls.worlds).toEqual([f.worldIds]);
      expect(f.calls.participants).toEqual([f.rooms.map((room) => room.id)]);
      expect(f.calls.singleWorlds).toBe(0);
      expect(f.calls.singleParticipants).toBe(0);
    },
  );

  it.each(["world", "participant"] as const)(
    "propagates a %s read failure instead of returning a partial feed",
    async (kind) => {
      const f = fixture();
      const error = new Error("Database unavailable");
      if (kind === "world") {
        f.methods.getWorld = async () => {
          throw error;
        };
        f.methods.getWorldsByIds = async () => {
          throw error;
        };
      } else {
        f.methods.getParticipantsForRoom = async () => {
          throw error;
        };
        f.methods.getParticipantsForRooms = async () => {
          throw error;
        };
      }
      await expect(fetchChatMessages(f.runtime, { limit: 3 })).rejects.toBe(
        error,
      );
    },
  );
});
