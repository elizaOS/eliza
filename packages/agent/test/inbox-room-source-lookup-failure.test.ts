/**
 * A storage failure while reading a room's latest message must not be reported
 * as "this room has no trusted connector source". The real POST
 * /api/inbox/messages handler resolves the room's connector source from its
 * newest message when the room record carries none; when that read throws, the
 * route used to answer 409 INBOX_ROOM_SOURCE_MISMATCH — a permanent-looking
 * routing conflict — instead of an observable 500. The empty-read case keeps
 * answering 409 because that room genuinely has no source.
 */
import { expect, it } from "vitest";
import { handleInboxRoute } from "../src/api/inbox-routes.ts";

const roomId = "11111111-1111-4111-8111-111111111111";

async function replyWithMemoryRead(
  getMemories: () => Promise<unknown[]>,
): Promise<{ status: number; body: unknown; sends: number }> {
  // No `source` on the room record: resolveTrustedRoomSource() has to fall back
  // to the room's newest message to decide which connector owns the room.
  const room = { id: roomId, channelId: "777000", metadata: {} };
  const manager = {
    registerProvider() {},
    getStorage: () => ({ listAccounts: async () => [] }),
    evaluatePolicy: async () => ({ allowed: true }),
    getAccount: async () => null,
    listAccounts: async () => [],
    listProviders: () => [],
  };
  let sends = 0;
  const runtime = {
    agentId: "agent",
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    getService: (type: string) => (type ? manager : null),
    getRoom: async () => room,
    sendHandlers: new Map([["telegram", () => {}]]),
    sendMessageToTarget: async () => {
      sends += 1;
      return { delivery: "delivered", receipts: [{ providerMessageId: "1" }] };
    },
    getMemories,
    getRoomsByIds: async () => [room],
  };
  let status = 200;
  let body: unknown;
  await handleInboxRoute(
    {} as never,
    {} as never,
    "/api/inbox/messages",
    "POST",
    {
      runtime: runtime as never,
      callerAuthorization: { ok: true, role: "OWNER" },
    } as never,
    {
      readJsonBody: async () => ({
        roomId,
        source: "telegram",
        text: "reply in the inbox",
      }),
      json: (_res: unknown, payload: unknown, code = 200) => {
        body = payload;
        status = code;
      },
      error: (_res: unknown, message: string, code = 500) => {
        body = { error: message };
        status = code;
      },
    } as never,
  );
  return { status, body, sends };
}

it("reports a failed source lookup as a server error, not a source mismatch", async () => {
  const result = await replyWithMemoryRead(async () => {
    throw new Error("pglite: connection terminated");
  });
  expect(result.status).toBe(500);
  expect(result.body).toMatchObject({
    code: "INBOX_ROOM_SOURCE_LOOKUP_FAILED",
  });
  expect(result.sends).toBe(0);
});

it("still rejects a room with no messages as having no trusted source", async () => {
  const result = await replyWithMemoryRead(async () => []);
  expect(result.status).toBe(409);
  expect(result.body).toMatchObject({ code: "INBOX_ROOM_SOURCE_MISMATCH" });
  expect(result.sends).toBe(0);
});
