/**
 * Regression coverage for the `GET /api/inbox/chats` ordering tie-break.
 *
 * #25594 added a deterministic tie-break to the chat sort but read it from
 * `a.roomId`, a field `InboxChat` does not have (the room id is `id`). The
 * comparator therefore threw `Cannot read properties of undefined` for any two
 * chats sharing a `lastMessageAt` — including the ordinary case of two rooms
 * with no messages, whose timestamps both clamp to 0 — and the route turned
 * that into a 500, so the whole inbox list failed to load.
 */
import type http from "node:http";
import type { AgentRuntime, RouteHelpers, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handleInboxRoute } from "./inbox-routes";

vi.mock("@elizaos/plugin-discord", () => ({
  cacheDiscordAvatarUrl: async (avatarUrl: string | undefined) => avatarUrl,
}));

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const WORLD_ID = "22222222-2222-2222-2222-222222222222" as UUID;
// Deliberately out of lexical order so the tie-break has something to do.
const ROOM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
const ROOM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const res = {} as http.ServerResponse;

/** Two rooms of the same source, neither carrying a message or a createdAt. */
function makeRuntime(): AgentRuntime {
  const room = (id: UUID) => ({
    id,
    worldId: WORLD_ID,
    source: "telegram",
    name: `room-${id.slice(0, 4)}`,
  });
  return {
    agentId: AGENT_ID,
    getAllWorlds: async () => [
      { id: WORLD_ID, name: "world", agentId: AGENT_ID },
    ],
    getRoomsByWorlds: async () => [room(ROOM_B), room(ROOM_A)],
    getMemoriesByRoomIds: async () => [],
    getMemories: async () => [],
    getParticipantUserState: async () => null,
    getRoom: async (id: UUID) => room(id),
    getEntityById: async () => null,
    getWorld: async () => ({ id: WORLD_ID, name: "world", agentId: AGENT_ID }),
  } as unknown as AgentRuntime;
}

function makeHelpers() {
  const json = vi.fn();
  const error = vi.fn();
  return {
    helpers: { json, error, readJsonBody: vi.fn() } as unknown as RouteHelpers,
    json,
    error,
  };
}

describe("GET /api/inbox/chats ordering", () => {
  it("sorts chats with identical timestamps instead of failing the request", async () => {
    const { helpers, json, error } = makeHelpers();
    const req = {
      url: "/api/inbox/chats",
      method: "GET",
    } as http.IncomingMessage;

    const handled = await handleInboxRoute(
      req,
      res,
      "/api/inbox/chats",
      "GET",
      { runtime: makeRuntime() } as never,
      helpers,
    );

    expect(handled).toBe(true);
    // The pre-fix comparator threw, and the route reported it as a 500.
    expect(error).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledTimes(1);

    const payload = json.mock.calls[0]?.[1] as {
      chats: Array<{ id: string; lastMessageAt: number }>;
    };
    expect(payload.chats).toHaveLength(2);
    // Every timestamp ties at 0, so the room id decides — ascending.
    expect(payload.chats.map((chat) => chat.id)).toEqual([ROOM_A, ROOM_B]);
    expect(payload.chats.every((chat) => chat.lastMessageAt === 0)).toBe(true);
  });
});
