/**
 * Chat deep links are built from the rooms and memories connectors store:
 * the channel lives on the room's top-level channelId, and the platform message
 * id on metadata.messageIdFull (memory ids are runtime UUIDs).
 */
import type { IAgentRuntime, Memory, Room, UUID, World } from "@elizaos/core";
import { ChannelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { fetchChatMessages } from "./message-fetcher.js";

const AGENT = "11111111-1111-4111-8111-111111111111" as UUID;
const SENDER = "22222222-2222-4222-8222-222222222222" as UUID;
const DISCORD_ROOM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const SLACK_ROOM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
const SLACK_WORLD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as UUID;

describe("fetchChatMessages deep links", () => {
  it("links Discord and Slack messages to their channel and platform message id", async () => {
    // Shapes written by plugin-discord history/ensureConnection and
    // plugin-slack ensureRoomExists: channel on Room.channelId, not metadata.
    const rooms: Room[] = [
      {
        id: DISCORD_ROOM,
        name: "general",
        source: "discord",
        type: ChannelType.GROUP,
        channelId: "1000000000000000020",
        serverId: "1000000000000000010",
        // A stale metadata copy must not override the stored channel.
        metadata: { accountId: "default", channelId: "stale-channel" },
      },
      {
        id: SLACK_ROOM,
        name: "eng",
        source: "slack",
        type: ChannelType.GROUP,
        channelId: "C0123",
        worldId: SLACK_WORLD,
        metadata: { accountId: "default", slack: { channelId: "C0123" } },
      },
    ];
    const worlds: World[] = [
      {
        id: SLACK_WORLD,
        agentId: AGENT,
        messageServerId: SLACK_WORLD,
        metadata: { teamId: "T0456" },
      },
    ];
    const memory = (
      id: string,
      roomId: UUID,
      source: string,
      platformId: string,
    ): Memory => ({
      id: id as UUID,
      agentId: AGENT,
      entityId: SENDER,
      roomId,
      createdAt: 1_700_000_000_000,
      content: { text: `hello from ${source}`, source },
      metadata: { type: "message", messageIdFull: platformId },
    });
    const memories = [
      memory(
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        DISCORD_ROOM,
        "discord",
        "1234567890123456789",
      ),
      memory(
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        SLACK_ROOM,
        "slack",
        "1700000000.000100",
      ),
    ];
    const runtime = {
      agentId: AGENT,
      getRoomsForParticipant: async () => [DISCORD_ROOM, SLACK_ROOM],
      getRoomsByIds: async (ids: UUID[]) =>
        rooms.filter((room) => ids.includes(room.id)),
      getMemoriesByRoomIds: async ({ roomIds }: { roomIds: UUID[] }) =>
        memories.filter((m) => roomIds.includes(m.roomId)),
      getParticipantsForRooms: async (ids: UUID[]) =>
        ids.map((roomId) => ({ roomId, entityIds: [AGENT, SENDER] })),
      getWorldsByIds: async (ids: UUID[]) =>
        worlds.filter((world) => ids.includes(world.id)),
    } as unknown as IAgentRuntime;

    const messages = await fetchChatMessages(runtime, {
      sources: ["discord", "slack"],
      limit: 10,
    });

    expect(
      Object.fromEntries(messages.map((m) => [m.source, m.deepLink])),
    ).toEqual({
      discord:
        "https://discord.com/channels/1000000000000000010/1000000000000000020/1234567890123456789",
      slack:
        "https://app.slack.com/client/T0456/C0123/thread/C0123-1700000000.000100",
    });
  });
});
