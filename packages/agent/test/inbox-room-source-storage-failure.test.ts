/**
 * Resolving a room's trusted connector source reads the message store when the
 * room itself has no persisted `source`. A storage failure there must surface
 * as a failure: returning null makes the POST handler answer
 * 409 INBOX_ROOM_SOURCE_MISMATCH, which tells the client the room is bound to a
 * different connector instead of that the store could not be read.
 */
import { expect, it } from "vitest";
import { handleInboxRoute } from "../src/api/inbox-routes.ts";

const ROOM_ID = "11111111-1111-4111-8111-111111111111";

it("propagates a message-store failure instead of reporting a missing room source", async () => {
  const storageFailure = new Error("SQLITE_BUSY: database is locked");
  // No persisted `source`, so the handler has to fall back to the message store.
  const room = { id: ROOM_ID, channelId: "777000" };
  const runtime = {
    agentId: "agent",
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    getService: () => null,
    getRoom: async () => room,
    getMemories: async () => {
      throw storageFailure;
    },
    sendHandlers: new Map(),
  };
  let status = 0;
  let body: unknown;
  const outcome = await handleInboxRoute(
    {} as never,
    {} as never,
    "/api/inbox/messages",
    "POST",
    {
      runtime: runtime as never,
      callerAuthorization: { ok: true, role: "OWNER" } as never,
    } as never,
    {
      readJsonBody: async () => ({
        roomId: ROOM_ID,
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
  ).then(
    () => ({ status, body }),
    (error: unknown) => ({ error }),
  );

  expect(outcome).toEqual({ error: storageFailure });
});
