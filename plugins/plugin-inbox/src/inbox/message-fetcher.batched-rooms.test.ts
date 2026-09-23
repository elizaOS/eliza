/**
 * Covers the chat-room scan in the inbox message fetcher: the agent's whole
 * room list is resolved through one batched room read rather than one read
 * per room. Deterministic runtime stub; no database.
 */
import type { IAgentRuntime, Room, UUID } from "@elizaos/core";
import { ChannelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { fetchChatMessages } from "./message-fetcher.js";

const AGENT = "11111111-1111-4111-8111-111111111111" as UUID;
const ROOM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const ROOM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
const ROOM_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as UUID;

describe("fetchChatMessages room resolution", () => {
  it("preserves participant room order and repetitions while filtering batch results", async () => {
    const batchReads: UUID[][] = [];
    const singleReads: UUID[] = [];
    const scannedRooms: UUID[][] = [];
    const missingRoom = "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as UUID;
    const rooms: Room[] = [ROOM_C, ROOM_B, ROOM_A].map((id) => ({
      id,
      name: `room-${id.slice(0, 2)}`,
      source: id === ROOM_C ? "telegram" : "discord",
      type: ChannelType.GROUP,
      channelId: `chan-${id.slice(0, 2)}`,
      serverId: "guild",
    }));
    const runtime = {
      agentId: AGENT,
      getRoomsForParticipant: async () => [
        ROOM_A,
        ROOM_B,
        ROOM_A,
        ROOM_C,
        missingRoom,
      ],
      getRoomsByIds: async (ids: UUID[]) => {
        batchReads.push([...ids]);
        return rooms.filter((room) => ids.includes(room.id));
      },
      getRoom: async (id: UUID) => {
        singleReads.push(id);
        return rooms.find((room) => room.id === id) ?? null;
      },
      getMemoriesByRoomIds: async ({ roomIds }: { roomIds: UUID[] }) => {
        scannedRooms.push(roomIds);
        return [];
      },
      getParticipantsForRoom: async () => [AGENT],
      getParticipantsForRooms: async (ids: UUID[]) =>
        ids.map((roomId) => ({ roomId, entityIds: [AGENT] })),
      getWorld: async () => null,
      getWorldsByIds: async () => [],
    } as unknown as IAgentRuntime;

    // SQL may return rows in any order, omit missing IDs and deduplicate.
    // The message scan must retain the original eligible room sequence.
    const messages = await fetchChatMessages(runtime, {
      sources: ["discord"],
      limit: 10,
    });

    expect(messages).toEqual([]);
    expect(batchReads).toEqual([[ROOM_A, ROOM_B, ROOM_A, ROOM_C, missingRoom]]);
    expect(scannedRooms).toEqual([[ROOM_A, ROOM_B, ROOM_A]]);
    expect(singleReads).toEqual([]);
  });
});
