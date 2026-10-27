/**
 * A chat message the agent answered later in the same DM is not "missed".
 * The fetcher sets repliedAt from the latest agent message in the DM, and
 * the missed-only inbox (the proactive digest) leaves the answered one out.
 * In a group room the agent may have answered someone else, so a message
 * there stays missed.
 */

import type { LifeOpsInboxChannel } from "@elizaos/contracts";
import type { IAgentRuntime, Memory, Room, UUID } from "@elizaos/core";
import { ChannelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { buildInbox } from "./aggregate.js";
import { fetchChatMessages } from "./message-fetcher.js";

const AGENT = "11111111-1111-4111-8111-111111111111" as UUID;
const SENDER = "22222222-2222-4222-8222-222222222222" as UUID;
const ANSWERED_ROOM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const OPEN_ROOM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
const ANSWERED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as UUID;
const REPLY = "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as UUID;
const OPEN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" as UUID;

describe("fetchChatMessages reply state", () => {
  it("leaves a message the agent answered out of the missed inbox", async () => {
    const asked = Date.now() - 48 * 60 * 60 * 1000;
    const rooms: Room[] = [ANSWERED_ROOM, OPEN_ROOM].map((id) => ({
      id,
      name: "Sam",
      source: "imessage",
      type: ChannelType.DM,
      channelId: `chat-${id}`,
      metadata: {},
    }));
    const memory = (
      id: UUID,
      roomId: UUID,
      entityId: UUID,
      createdAt: number,
      text: string,
    ): Memory => ({
      id,
      agentId: AGENT,
      entityId,
      roomId,
      createdAt,
      content: { text, source: "imessage" },
      metadata: { type: "message" },
    });
    // Newest first, as the memory stores return room reads.
    const memories = [
      memory(REPLY, ANSWERED_ROOM, AGENT, asked + 60_000, "Yes, 3pm works."),
      memory(OPEN, OPEN_ROOM, SENDER, asked, "Can you send the contract?"),
      memory(ANSWERED, ANSWERED_ROOM, SENDER, asked, "Are you free at 3pm?"),
    ];
    const runtime = {
      agentId: AGENT,
      getRoomsForParticipant: async () => [ANSWERED_ROOM, OPEN_ROOM],
      getRoomsByIds: async (ids: UUID[]) =>
        rooms.filter((room) => ids.includes(room.id)),
      getMemoriesByRoomIds: async ({
        roomIds,
        offset = 0,
      }: {
        roomIds: UUID[];
        offset?: number;
      }) => memories.filter((m) => roomIds.includes(m.roomId)).slice(offset),
      getParticipantsForRooms: async (ids: UUID[]) =>
        ids.map((roomId) => ({ roomId, entityIds: [AGENT, SENDER] })),
      getWorldsByIds: async () => [],
    } as unknown as IAgentRuntime;

    const messages = await fetchChatMessages(runtime, {
      sources: ["imessage"],
      limit: 10,
    });

    const repliedById = Object.fromEntries(
      messages.map((m) => [m.id, m.repliedAt ?? null]),
    );
    expect(repliedById).toEqual({
      [ANSWERED]: new Date(asked + 60_000).toISOString(),
      [OPEN]: null,
    });

    const inbox = buildInbox(messages, {
      limit: 24,
      allowed: new Set<LifeOpsInboxChannel>(["imessage"]),
      sources: [{ source: "chat", state: "ok", degradations: [] }],
      groupByThread: true,
      missedOnly: true,
      llmScores: new Map([
        [
          `imessage:${ANSWERED}`,
          { score: 90, category: "important", flags: [] },
        ],
        [`imessage:${OPEN}`, { score: 90, category: "important", flags: [] }],
      ]),
    });
    expect(inbox.messages.map((message) => message.id)).toEqual([
      `imessage:${OPEN}`,
    ]);
  });

  it("keeps a group message missed when the agent answered someone else", async () => {
    const asked = Date.now() - 48 * 60 * 60 * 1000;
    const OTHER = "ffffffff-ffff-4fff-8fff-ffffffffffff" as UUID;
    const room: Room = {
      id: ANSWERED_ROOM,
      name: "Project",
      source: "imessage",
      type: ChannelType.GROUP,
      channelId: "chat-project",
      metadata: {},
    };
    const memory = (
      id: UUID,
      entityId: UUID,
      createdAt: number,
      text: string,
    ): Memory => ({
      id,
      agentId: AGENT,
      entityId,
      roomId: ANSWERED_ROOM,
      createdAt,
      content: { text, source: "imessage" },
      metadata: { type: "message" },
    });
    // Newest first: the agent answers OTHER after SENDER asked.
    const memories = [
      memory(REPLY, AGENT, asked + 60_000, "Other, the deck is attached."),
      memory(OPEN, SENDER, asked, "Can you send the contract?"),
      memory(ANSWERED, OTHER, asked - 60_000, "Can you send the deck?"),
    ];
    const runtime = {
      agentId: AGENT,
      getRoomsForParticipant: async () => [ANSWERED_ROOM],
      getRoomsByIds: async () => [room],
      getMemoriesByRoomIds: async ({ offset = 0 }: { offset?: number }) =>
        memories.slice(offset),
      getParticipantsForRooms: async (ids: UUID[]) =>
        ids.map((roomId) => ({ roomId, entityIds: [AGENT, SENDER, OTHER] })),
      getWorldsByIds: async () => [],
    } as unknown as IAgentRuntime;

    const messages = await fetchChatMessages(runtime, {
      sources: ["imessage"],
      limit: 10,
    });

    expect(messages.find((m) => m.id === OPEN)?.repliedAt).toBeUndefined();
  });
});
