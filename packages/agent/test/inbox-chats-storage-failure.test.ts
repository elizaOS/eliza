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
  const reported: Array<{ scope: string; error: unknown }> = [];
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
    reportError: (scope: string, error: unknown) => {
      reported.push({ scope, error });
    },
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
  return { status, body, reported };
}

it("reports a message-storage failure instead of an empty chat", async () => {
  const { status, body } = await listChats(async () => {
    throw new Error("SQLITE_IOERR: disk I/O error");
  });
  expect(status).toBe(500);
  expect(body.error).toContain("failed to load inbox chats");
});

it("keeps storage detail out of the response and reports the cause", async () => {
  // A driver message can carry the database path, SQL text, or a remote host.
  // The route interpolates `err.message` into the body, so the detail must stop
  // at the helper boundary and travel through the diagnostic hook instead.
  const sentinel = "SENTINEL_HOST_PATH=/var/lib/eliza/secrets/agent.db";
  const { status, body, reported } = await listChats(async () => {
    throw new Error(
      `SQLITE_CANTOPEN: unable to open database file ${sentinel}`,
    );
  });
  expect(status).toBe(500);
  expect(body.error).toContain("Inbox message history is unavailable.");
  expect(JSON.stringify(body)).not.toContain("SENTINEL_HOST_PATH");
  expect(reported).toHaveLength(1);
  const report = reported[0];
  expect(report?.scope).toBe("inbox-message-history");
  expect(report?.error).toBeInstanceOf(Error);
  expect((report?.error as Error | undefined)?.message).toContain(
    "SENTINEL_HOST_PATH",
  );
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

it("does not read a missing sibling table as a missing messages table", async () => {
  // `messages_archive` is a different table. Only a missing `messages` table is
  // the benign pre-migration case; anything else is a real storage failure.
  const { status, body } = await listChats(async () => {
    throw new Error("no such table: messages_archive");
  });
  expect(status).toBe(500);
  expect(body.error).toContain("failed to load inbox chats");
});

it("keeps a qualified messages table name as the benign pre-migration case", async () => {
  const { status } = await listChats(async () => {
    throw new Error("no such table: main.messages");
  });
  expect(status).toBe(200);
});
