import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

const USER = "00000000-0000-4000-8000-0000000000bb";
const ORG = "00000000-0000-4000-8000-0000000000aa";

const requireUserWithOrg = mock();
const findRoomsByEntityId = mock();
const findRoomsByIds = mock();
const findCharacterById = mock();
const listCharactersByUser = mock();
const getUserById = mock();
const getAnonymousSessionByToken = mock();
const markAnonymousSessionConverted = mock();
const claimAffiliateCharacter = mock();

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserWithOrg,
}));

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: () =>
    new Response(JSON.stringify({ success: false, error: "auth failed" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }),
}));

mock.module("hono/http-exception", () => ({
  HTTPException: class HTTPException extends Error {
    status: number;

    constructor(status = 500, options?: { message?: string }) {
      super(options?.message);
      this.status = status;
    }
  },
}));

mock.module("@/db/repositories", () => ({
  participantsRepository: {
    findRoomsByEntityId,
  },
  roomsRepository: {
    findByIds: findRoomsByIds,
  },
  userCharactersRepository: {
    findById: findCharacterById,
    listByUser: listCharactersByUser,
  },
}));

mock.module("@/lib/services/users", () => ({
  usersService: {
    getById: getUserById,
  },
}));

mock.module("@/lib/services/anonymous-sessions", () => ({
  anonymousSessionsService: {
    getByToken: getAnonymousSessionByToken,
    markConverted: markAnonymousSessionConverted,
  },
}));

mock.module("@/lib/services/characters/characters", () => ({
  charactersService: {
    claimAffiliateCharacter,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

let route: { default: { fetch: (req: Request) => Promise<Response> } };

beforeAll(async () => {
  route = await import("../my-agents/claim-affiliate-characters/route");
});

beforeEach(() => {
  requireUserWithOrg.mockReset();
  findRoomsByEntityId.mockReset();
  findRoomsByIds.mockReset();
  findCharacterById.mockReset();
  listCharactersByUser.mockReset();
  getUserById.mockReset();
  getAnonymousSessionByToken.mockReset();
  markAnonymousSessionConverted.mockReset();
  claimAffiliateCharacter.mockReset();

  requireUserWithOrg.mockResolvedValue({
    id: USER,
    organization_id: ORG,
  });
  findRoomsByEntityId.mockResolvedValue([]);
  findRoomsByIds.mockResolvedValue([]);
  findCharacterById.mockResolvedValue(null);
  listCharactersByUser.mockResolvedValue([]);
  getUserById.mockResolvedValue(null);
  getAnonymousSessionByToken.mockResolvedValue(null);
  markAnonymousSessionConverted.mockResolvedValue(undefined);
  claimAffiliateCharacter.mockResolvedValue({
    success: true,
    message: "claimed",
  });
});

function postClaim(body: unknown = {}) {
  return route.default.fetch(
    new Request("http://test.local/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/my-agents/claim-affiliate-characters", () => {
  test("ignores non-character room agent IDs before querying user_characters UUIDs", async () => {
    findRoomsByEntityId.mockResolvedValue(["room-1"]);
    findRoomsByIds.mockResolvedValue([
      { id: "room-1", agentId: "runtime-agent-not-a-character-uuid" },
    ]);

    const res = await postClaim();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success?: boolean;
      claimed?: unknown[];
    };
    expect(body.success).toBe(true);
    expect(body.claimed).toEqual([]);
    expect(findCharacterById).not.toHaveBeenCalled();
  });

  test("returns a non-500 response when the post-auth claim sweep fails", async () => {
    findRoomsByEntityId.mockRejectedValue(new Error("staging schema drift"));

    const res = await postClaim();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success?: boolean;
      claimed?: unknown[];
      message?: string;
    };
    expect(body.success).toBe(false);
    expect(body.claimed).toEqual([]);
    expect(body.message).toContain("page can continue loading");
  });
});
