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

  it("links Slack and Telegram from the exact rooms those connectors persist", async () => {
    // plugin-slack ensureRoomExists: team id only as room metadata `serverId`,
    // Room.serverId column unset; the workspace world nests teamId in `extra`.
    // plugin-telegram ensureConnection: Room.channelId = <chat.id>, and no
    // username/chatId room metadata at all.
    const TELEGRAM_ROOM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaabbb" as UUID;
    const SLACK_ROOM2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbacc" as UUID;
    const SLACK_WORLD2 = "cccccccc-cccc-4ccc-8ccc-cccccccccdcc" as UUID;
    const rooms: Room[] = [
      {
        id: SLACK_ROOM2,
        name: "eng",
        source: "slack",
        type: ChannelType.GROUP,
        channelId: "C0123",
        worldId: SLACK_WORLD2,
        metadata: {
          source: "slack",
          accountId: "default",
          slackChannelType: "channel",
          serverId: "T0456",
          slack: { accountId: "default", teamId: "T0456", channelId: "C0123" },
        },
      },
      {
        id: TELEGRAM_ROOM,
        name: "Private Supergroup",
        source: "telegram",
        type: ChannelType.GROUP,
        channelId: "-1001234567890",
      },
    ];
    const worlds: World[] = [
      {
        id: SLACK_WORLD2,
        agentId: AGENT,
        messageServerId: SLACK_WORLD2,
        metadata: {
          type: "slack",
          source: "slack",
          accountId: "default",
          extra: { accountId: "default", teamId: "T0456", domain: "team" },
        },
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
        "dddddddd-dddd-4ddd-8ddd-dddddddddeee",
        SLACK_ROOM2,
        "slack",
        "1700000000.000100",
      ),
      memory(
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeefff",
        TELEGRAM_ROOM,
        "telegram",
        "42",
      ),
    ];
    const runtime = {
      agentId: AGENT,
      getRoomsForParticipant: async () => [SLACK_ROOM2, TELEGRAM_ROOM],
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
      sources: ["slack", "telegram"],
      limit: 10,
    });

    expect(
      Object.fromEntries(messages.map((m) => [m.source, m.deepLink])),
    ).toEqual({
      slack:
        "https://app.slack.com/client/T0456/C0123/thread/C0123-1700000000.000100",
      telegram: "https://t.me/c/1234567890/42",
    });
  });

  it("links a 1:1 iMessage from the chat id the connector persists and skips groups", async () => {
    // plugin-imessage dispatchInboundMessage → ensureRoomExists: channelId and
    // metadata.chatId are chat.db chat_identifier. No handle / chat_identifier.
    const DIRECT_ROOM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaccc" as UUID;
    const GROUP_ROOM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbddd" as UUID;
    const rooms: Room[] = [
      {
        id: DIRECT_ROOM,
        name: "+15551234567",
        source: "imessage",
        type: ChannelType.DM,
        channelId: "iMessage;-;+15551234567",
        metadata: {
          accountId: "default",
          chatId: "iMessage;-;+15551234567",
          chatType: "direct",
        },
      },
      {
        id: GROUP_ROOM,
        name: "Family",
        source: "imessage",
        type: ChannelType.GROUP,
        channelId: "iMessage;+;chat123",
        metadata: {
          accountId: "default",
          chatId: "iMessage;+;chat123",
          chatType: "group",
        },
      },
    ];
    const memory = (id: string, roomId: UUID, text: string): Memory => ({
      id: id as UUID,
      agentId: AGENT,
      entityId: SENDER,
      roomId,
      createdAt: 1_700_000_000_000,
      content: { text, source: "imessage" },
      metadata: { type: "message", messageIdFull: "guid-1" },
    });
    const memories = [
      memory("dddddddd-dddd-4ddd-8ddd-ddddddddd111", DIRECT_ROOM, "ping"),
      memory("eeeeeeee-eeee-4eee-8eee-eeeeeeeee222", GROUP_ROOM, "group ping"),
    ];
    const runtime = {
      agentId: AGENT,
      getRoomsForParticipant: async () => [DIRECT_ROOM, GROUP_ROOM],
      getRoomsByIds: async (ids: UUID[]) =>
        rooms.filter((room) => ids.includes(room.id)),
      getMemoriesByRoomIds: async ({ roomIds }: { roomIds: UUID[] }) =>
        memories.filter((m) => roomIds.includes(m.roomId)),
      getParticipantsForRooms: async (ids: UUID[]) =>
        ids.map((roomId) => ({ roomId, entityIds: [AGENT, SENDER] })),
      getWorldsByIds: async () => [],
    } as unknown as IAgentRuntime;

    const messages = await fetchChatMessages(runtime, {
      sources: ["imessage"],
      limit: 10,
    });

    expect(
      Object.fromEntries(messages.map((m) => [m.text, m.deepLink])),
    ).toEqual({
      ping: "imessage://+15551234567",
      "group ping": undefined,
    });
  });
});
