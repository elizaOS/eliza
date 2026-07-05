/**
 * Inbox chats mute honesty for Discord threads: GET /api/inbox/chats must
 * report a thread muted when its PARENT channel's room carries the persisted
 * mute — the same [room, parent] inheritance the connector's inbound gate
 * enforces when it drops the thread's messages. Real handleInboxRoute over a
 * map-backed runtime and a fake discord client cache; muted flags are
 * asserted from the JSON the route actually serves.
 */
import type http from "node:http";
import type { AgentRuntime, RouteHelpers, UUID } from "@elizaos/core";
import { createUniqueUuid } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { handleInboxRoute, type InboxRouteState } from "../inbox-routes";

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-0000000000e1" as UUID;

const MUTED_PARENT_CHANNEL_ID = "parent-muted-1";
const MUTED_THREAD_CHANNEL_ID = "thread-of-muted-1";
const OPEN_PARENT_CHANNEL_ID = "parent-open-1";
const OPEN_THREAD_CHANNEL_ID = "thread-of-open-1";

function fakeThreadChannel(id: string, name: string, parentId: string) {
  return {
    id,
    name,
    parentId,
    isThread: () => true,
  };
}

function makeHarness() {
  const states = new Map<string, "FOLLOWED" | "MUTED" | null>();
  const rooms = new Map<string, Record<string, unknown>>();
  const worlds = new Map<string, Record<string, unknown>>([
    [WORLD_ID, { id: WORLD_ID, agentId: AGENT_ID, name: "Guild" }],
  ]);
  const channels = new Map<string, unknown>();

  const runtime = {
    agentId: AGENT_ID,
    getAllWorlds: async () => Array.from(worlds.values()),
    getRoomsByWorlds: async () => Array.from(rooms.values()),
    getMemories: async () => [],
    getMemoriesByRoomIds: async ({ roomIds }: { roomIds: UUID[] }) =>
      roomIds.map((roomId, index) => ({
        id: `00000000-0000-0000-0000-00000000f${index}0${index}` as UUID,
        roomId,
        entityId: undefined,
        content: { text: "hello", source: "discord" },
        createdAt: 1_000 + index,
      })),
    getParticipantUserState: async (roomId: UUID, entityId: UUID) =>
      states.get(`${roomId}:${entityId}`) ?? null,
    updateParticipantUserState: async (
      roomId: UUID,
      entityId: UUID,
      state: "FOLLOWED" | "MUTED" | null,
    ) => {
      states.set(`${roomId}:${entityId}`, state);
    },
    getRoom: async (roomId: UUID) => rooms.get(roomId) ?? null,
    updateRoom: async (room: { id: string }) => {
      rooms.set(room.id, room);
    },
    getWorld: async (worldId: UUID) => worlds.get(worldId) ?? null,
    updateWorld: async (world: { id: string }) => {
      worlds.set(world.id, world);
    },
    getService: (name: string) =>
      name === "discord"
        ? {
            client: {
              channels: { cache: { get: (id: string) => channels.get(id) } },
            },
          }
        : null,
  } as unknown as AgentRuntime;

  const addThreadRoom = (channelId: string, parentChannelId: string) => {
    const roomId = createUniqueUuid(runtime, channelId);
    rooms.set(roomId, {
      id: roomId,
      name: `#${channelId}`,
      source: "discord",
      type: "GROUP",
      worldId: WORLD_ID,
      channelId,
    });
    channels.set(
      channelId,
      fakeThreadChannel(channelId, channelId, parentChannelId),
    );
    return roomId;
  };

  return { runtime, states, addThreadRoom };
}

async function getChats(runtime: AgentRuntime) {
  let payload: { chats: Array<Record<string, unknown>> } | undefined;
  const helpers = {
    json: (_res: http.ServerResponse, data: unknown) => {
      payload = data as { chats: Array<Record<string, unknown>> };
    },
    error: (_res: http.ServerResponse, message: string) => {
      throw new Error(`route error: ${message}`);
    },
    readJsonBody: async () => null,
  } as unknown as RouteHelpers;

  const handled = await handleInboxRoute(
    { url: "/api/inbox/chats" } as http.IncomingMessage,
    {} as http.ServerResponse,
    "/api/inbox/chats",
    "GET",
    { runtime } as InboxRouteState,
    helpers,
  );
  expect(handled).toBe(true);
  if (!payload) throw new Error("route did not respond");
  return payload.chats;
}

describe("GET /api/inbox/chats — thread inherits parent channel mute", () => {
  it("reports a thread of a muted parent as muted, an open one as unmuted", async () => {
    const { runtime, states, addThreadRoom } = makeHarness();
    const mutedThreadRoomId = addThreadRoom(
      MUTED_THREAD_CHANNEL_ID,
      MUTED_PARENT_CHANNEL_ID,
    );
    const openThreadRoomId = addThreadRoom(
      OPEN_THREAD_CHANNEL_ID,
      OPEN_PARENT_CHANNEL_ID,
    );
    // Same persisted state the ROOM action writes and the inbound gate reads
    // when it drops the thread's messages.
    const mutedParentRoomId = createUniqueUuid(
      runtime,
      MUTED_PARENT_CHANNEL_ID,
    );
    states.set(`${mutedParentRoomId}:${AGENT_ID}`, "MUTED");

    const chats = await getChats(runtime);
    const mutedThreadChat = chats.find((c) => c.id === mutedThreadRoomId);
    const openThreadChat = chats.find((c) => c.id === openThreadRoomId);

    expect(mutedThreadChat).toBeDefined();
    expect(openThreadChat).toBeDefined();
    expect(mutedThreadChat?.muted).toBe(true);
    expect(mutedThreadChat?.mutedScope).toBe("room");
    expect(openThreadChat?.muted).toBe(false);
  });
});
