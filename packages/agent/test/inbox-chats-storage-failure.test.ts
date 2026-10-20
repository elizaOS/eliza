/**
 * A message-storage failure while a chat's preview is being built must not be
 * reported as an empty conversation. `GET /api/inbox/chats` already has a 500
 * path for aggregation failures; a failing `getMemories` on the preview read
 * must reach it instead of yielding `messageCount: 0`.
 */
import { expect, it } from "vitest";
import { handleInboxRoute } from "../src/api/inbox-routes.ts";

const WORLD_ID = "22222222-2222-4222-8222-222222222222";
const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";

/** Drive the real GET /api/inbox/chats handler against a stub runtime. */
async function listChats(
  readRoomMemories: (roomId: string) => Promise<unknown[]>,
) {
  let status = 200;
  let body: Record<string, unknown> = {};
  const world = { id: WORLD_ID, name: "connector", metadata: {} };
  const room = {
    id: ROOM_ID,
    name: "Telegram chat",
    source: "telegram",
    type: "DM",
    metadata: {},
    worldId: WORLD_ID,
  };
  const runtime = {
    agentId: AGENT_ID,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    getAllWorlds: async () => [world],
    getRoomsByWorlds: async () => [room],
    getMemories: async (params: { roomId?: string }) =>
      params.roomId ? await readRoomMemories(params.roomId) : [],
    getMemoriesByRoomIds: async () => [],
    getService: () => null,
    hasService: () => false,
    getSetting: () => undefined,
    getRoom: async () => room,
    getWorld: async () => world,
    getRoomsByIds: async () => [room],
    getParticipantUserState: async () => null,
    getEntityById: async () => null,
  };
  await handleInboxRoute(
    { url: "/api/inbox/chats", method: "GET", headers: {} } as never,
    {} as never,
    "/api/inbox/chats",
    "GET",
    { runtime: runtime as never } as never,
    {
      json: (_res: unknown, payload: unknown, code = 200) => {
        body = payload as Record<string, unknown>;
        status = code;
      },
      error: (_res: unknown, message: string, code = 500) => {
        body = { error: message };
        status = code;
      },
    } as never,
  );
  return { status, body };
}

it("reports a message-storage failure instead of an empty chat", async () => {
  const { status, body } = await listChats(async () => {
    throw new Error("SQLITE_IOERR: disk I/O error");
  });
  expect(status).toBe(500);
  expect(body.error).toContain("failed to load inbox chats");
});

it("keeps a genuinely message-less room as an empty chat", async () => {
  const { status, body } = await listChats(async () => []);
  expect(status).toBe(200);
  const chats = body.chats as Array<{ messageCount: number }>;
  expect(chats).toHaveLength(1);
  expect(chats[0]?.messageCount).toBe(0);
});

it("keeps a runtime without a messages table as an empty chat", async () => {
  const { status, body } = await listChats(async () => {
    throw new Error("no such table: messages");
  });
  expect(status).toBe(200);
  const chats = body.chats as Array<{ messageCount: number }>;
  expect(chats).toHaveLength(1);
  expect(chats[0]?.messageCount).toBe(0);
});
