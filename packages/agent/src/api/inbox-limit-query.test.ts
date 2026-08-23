/**
 * Regression coverage for the untrusted `limit` query on
 * `GET /api/inbox/messages`. The handler must reject non-canonical integers
 * before it reads inbox state, while preserving the default and hard cap.
 */
import type http from "node:http";
import type { AgentRuntime, RouteHelpers, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handleInboxRoute } from "./inbox-routes";

// Messages route lazily imports the connector plugin for avatar caching.
// This suite only exercises the untrusted `limit` query.
vi.mock("@elizaos/plugin-discord", () => ({
  cacheDiscordAvatarUrl: async (avatarUrl: string | undefined) => avatarUrl,
}));

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const ROOM_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const res = {} as http.ServerResponse;

function makeHelpers() {
  const json = vi.fn();
  const error = vi.fn();
  const readJsonBody = vi.fn();
  return {
    helpers: { json, error, readJsonBody } as RouteHelpers,
    json,
    error,
  };
}

function makeRuntime() {
  const getRoom = vi.fn(async () => ({
    id: ROOM_ID,
    name: "Inbox",
    source: "discord",
  }));
  const getMemories = vi.fn(async () => []);
  const runtime = {
    agentId: AGENT_ID,
    getRoom,
    getMemories,
    getService: () => null,
  } as unknown as AgentRuntime;
  return { runtime, getRoom, getMemories };
}

async function requestInboxLimit(raw?: string) {
  const { runtime, getRoom, getMemories } = makeRuntime();
  const { helpers, json, error } = makeHelpers();
  const query = raw === undefined ? "" : `&limit=${encodeURIComponent(raw)}`;
  const url = `/api/inbox/messages?roomId=${ROOM_ID}&sources=discord${query}`;
  const handled = await handleInboxRoute(
    { url } as http.IncomingMessage,
    res,
    "/api/inbox/messages",
    "GET",
    { runtime },
    helpers,
  );
  return { handled, getRoom, getMemories, json, error };
}

async function requestInboxLimitNoRuntime(raw?: string) {
  const { helpers, json, error } = makeHelpers();
  const query = raw === undefined ? "" : `&limit=${encodeURIComponent(raw)}`;
  const url = `/api/inbox/messages?roomId=${ROOM_ID}&sources=discord${query}`;
  const handled = await handleInboxRoute(
    { url } as http.IncomingMessage,
    res,
    "/api/inbox/messages",
    "GET",
    { runtime: null },
    helpers,
  );
  return { handled, json, error };
}

describe("GET /api/inbox/messages limit query", () => {
  it.each([
    "1e3",
    "50abc",
    "0x10",
    "50.5",
    "abc",
    "-1",
    "1_000",
    "+5",
    " 5",
    "5 ",
    "0",
    "Infinity",
    "NaN",
    "01",
    "9007199254740992",
  ])("rejects malformed limit %j before reading inbox state", async (raw) => {
    const result = await requestInboxLimit(raw);

    expect(result.handled).toBe(true);
    expect(result.error).toHaveBeenCalledWith(
      res,
      "limit must be a positive integer",
      400,
    );
    expect(result.json).not.toHaveBeenCalled();
    expect(result.getRoom).not.toHaveBeenCalled();
    expect(result.getMemories).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 100],
    ["", 100],
    ["25", 25],
    ["500", 500],
    ["501", 500],
  ] as const)("accepts limit %j as %s", async (raw, expected) => {
    const result = await requestInboxLimit(raw);

    expect(result.handled).toBe(true);
    expect(result.error).not.toHaveBeenCalled();
    expect(result.getRoom).toHaveBeenCalledWith(ROOM_ID);
    expect(result.getMemories).toHaveBeenCalledWith({
      tableName: "messages",
      roomId: ROOM_ID,
      limit: expected * 3,
      unique: false,
    });
    expect(result.json).toHaveBeenCalledWith(res, { messages: [], count: 0 });
  });

  it("sorts inbox messages safely when timestamp contains NaN", () => {
    const messages = [
      { id: "msg-nan", timestamp: NaN },
      { id: "msg-valid", timestamp: 1700000000000 },
    ];

    messages.sort((a, b) => {
      const bTime =
        typeof b.timestamp === "number" && Number.isFinite(b.timestamp)
          ? b.timestamp
          : 0;
      const aTime =
        typeof a.timestamp === "number" && Number.isFinite(a.timestamp)
          ? a.timestamp
          : 0;
      return bTime - aTime || a.id.localeCompare(b.id);
    });

    expect(messages[0]?.id).toBe("msg-valid");
    expect(messages[1]?.id).toBe("msg-nan");
  });

  it.each(["1e3", "50abc", "0x10", "0", "01"])(
    "rejects malformed limit %j with 400 when runtime is unavailable",
    async (raw) => {
      const result = await requestInboxLimitNoRuntime(raw);

      expect(result.handled).toBe(true);
      expect(result.error).toHaveBeenCalledWith(
        res,
        "limit must be a positive integer",
        400,
      );
      expect(result.json).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "", "25"] as const)(
    "keeps the empty inbox response for limit %j when runtime is unavailable",
    async (raw) => {
      const result = await requestInboxLimitNoRuntime(raw);

      expect(result.handled).toBe(true);
      expect(result.error).not.toHaveBeenCalled();
      expect(result.json).toHaveBeenCalledWith(res, { messages: [], count: 0 });
    },
  );
});
