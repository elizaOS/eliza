/**
 * The inbox sidebar is newest-activity first. Two chats whose latest
 * messages share a millisecond must keep the higher room UUID on top.
 */
import type http from "node:http";
import type { AgentRuntime, Memory, Room, UUID, World } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { handleInboxRoute } from "../src/api/inbox-routes.ts";

const AGENT = "11111111-1111-4111-8111-111111111111" as UUID;
const WORLD = "33333333-3333-4333-8333-333333333333" as UUID;
const LOWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const UPPER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
const SAME = 1_700_000_000_000;

function room(id: UUID): Room {
  return {
    id,
    agentId: AGENT,
    worldId: WORLD,
    source: "telegram",
    type: "GROUP",
    name: `chat ${id}`,
  };
}

function message(roomId: UUID): Memory {
  return {
    id: `99999999-9999-4999-8999-${roomId.slice(0, 12)}` as UUID,
    agentId: AGENT,
    entityId: AGENT,
    roomId,
    createdAt: SAME,
    content: { text: "hello", source: "telegram" },
  };
}

describe("inbox chat UUID ties", () => {
  it("lists the higher room UUID first when latest activity shares a millisecond", async () => {
    const world: World = { id: WORLD, agentId: AGENT, name: "Telegram" };
    let body = "";
    const runtime = {
      agentId: AGENT,
      getAllWorlds: async () => [world],
      getWorld: async () => world,
      getRoomsByWorlds: async () => [room(LOWER), room(UPPER)],
      getMemories: async () => [],
      getMemoriesByRoomIds: async () => [message(LOWER), message(UPPER)],
      getParticipantUserState: async () => null,
    } as unknown as AgentRuntime;

    const handled = await handleInboxRoute(
      { url: "/api/inbox/chats?sources=telegram" } as http.IncomingMessage,
      { setHeader() {}, end() {} } as unknown as http.ServerResponse,
      "/api/inbox/chats",
      "GET",
      { runtime },
      {
        json(_res, data) {
          body = JSON.stringify(data);
        },
        error(_res, message) {
          throw new Error(message);
        },
        readJsonBody: async () => null,
      },
    );

    expect(handled).toBe(true);
    const chats = JSON.parse(body).chats as Array<{ id: string }>;
    expect(chats.map((chat) => chat.id)).toEqual([UPPER, LOWER]);
  });
});
