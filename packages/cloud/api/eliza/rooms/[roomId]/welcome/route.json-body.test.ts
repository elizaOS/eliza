/**
 * POST /api/eliza/rooms/:roomId/welcome untrusted JSON body contract.
 *
 * Hono 4.13 `c.req.json()` is a bare `JSON.parse`. An uncaught SyntaxError
 * was HTTP 500 before auth or the first-agent memory write. Caller garbage
 * must be 400 and must not create a welcome memory.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const USER_ID = "00000000-0000-4000-8000-0000000000cc";

const requireUserOrApiKey = mock(async () => ({ id: USER_ID }));
const hasAccess = mock(async () => true);
const entitiesCreate = mock(async () => undefined);
const memoriesCreate = mock(async (row: { id: string }) => ({ id: row.id }));
const deleteMessages = mock(async () => undefined);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKey,
}));

mock.module("@/lib/services/agents/rooms", () => ({
  roomsService: { hasAccess },
}));

mock.module("@/db/repositories", () => ({
  entitiesRepository: { create: entitiesCreate },
  memoriesRepository: { create: memoriesCreate, deleteMessages },
}));

mock.module("@/lib/services/anonymous-sessions", () => ({
  anonymousSessionsService: { getByToken: mock(async () => null) },
}));

mock.module("@/lib/services/users", () => ({
  usersService: { getById: mock(async () => null) },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
  },
}));

const { default: app } = await import("./route");

function post(raw: string) {
  return app.fetch(
    new Request("http://test.local/", {
      method: "POST",
      headers: {
        Authorization: "Bearer eliza_test_key",
        "Content-Type": "application/json",
      },
      body: raw,
    }),
  );
}

describe("POST /api/eliza/rooms/:roomId/welcome JSON body", () => {
  beforeEach(() => {
    requireUserOrApiKey.mockClear();
    hasAccess.mockClear();
    entitiesCreate.mockClear();
    memoriesCreate.mockClear();
  });

  test.each(["", "   ", "{", "not-json"])(
    "rejects malformed welcome body %j with 400",
    async (raw) => {
      const res = await post(raw);

      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toEqual({
        error: "Invalid JSON body",
      });
      expect(requireUserOrApiKey).not.toHaveBeenCalled();
      expect(memoriesCreate).not.toHaveBeenCalled();
      expect(entitiesCreate).not.toHaveBeenCalled();
    },
  );

  test.each(['["hi"]', '"welcome"', "null", "12"])(
    "rejects non-object welcome body %s with 400",
    async (raw) => {
      const res = await post(raw);

      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toEqual({
        error: "Invalid JSON body",
      });
      expect(requireUserOrApiKey).not.toHaveBeenCalled();
      expect(memoriesCreate).not.toHaveBeenCalled();
    },
  );

  test("still 400s a parseable object missing text", async () => {
    const res = await post("{}");

    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({
      error: "text is required",
    });
    expect(requireUserOrApiKey).not.toHaveBeenCalled();
    expect(memoriesCreate).not.toHaveBeenCalled();
  });

  test("still stores a canonical welcome object", async () => {
    const res = await post(JSON.stringify({ text: "Hello from Eliza" }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success?: boolean;
      messageId?: string;
    };
    expect(body.success).toBe(true);
    expect(typeof body.messageId).toBe("string");
    expect(requireUserOrApiKey).toHaveBeenCalled();
    expect(hasAccess).toHaveBeenCalledWith("", USER_ID);
    expect(memoriesCreate).toHaveBeenCalledTimes(1);
    expect(memoriesCreate.mock.calls[0]?.[0]).toMatchObject({
      roomId: "",
      type: "messages",
      content: { text: "Hello from Eliza", source: "agent" },
    });
  });
});
