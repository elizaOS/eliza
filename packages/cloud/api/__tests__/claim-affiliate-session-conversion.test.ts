// Proves the affiliate-claim route converts an anonymous session only after
// every session-backed ownership transfer in the attempt succeeds, keeping the
// session retryable across returned or thrown claim failures. Harness: the
// real Hono route with deterministic repository and service boundaries.
import { describe, expect, mock, test } from "bun:test";

type ClaimResult = { success: boolean; message: string };

const USER_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const SESSION_ID = "00000000-0000-4000-8000-000000000003";
const ANON_ID = "00000000-0000-4000-8000-000000000004";
const OTHER_ANON_ID = "00000000-0000-4000-8000-000000000005";
const SESSION_TOKEN = "anon-session-token";
const CHAR_A = "00000000-0000-4000-8000-00000000000a";
const CHAR_B = "00000000-0000-4000-8000-00000000000b";
const CHAR_ROOM = "00000000-0000-4000-8000-00000000000c";

interface Deps {
  events: string[];
  session: { id: string; user_id: string; converted_at: string | null } | null;
  sessionCharacters: Array<{ id: string; user_id: string; name: string }>;
  roomCharacters: Array<{
    id: string;
    user_id: string;
    name: string;
    is_anonymous: boolean;
  }>;
  claimResults: Record<string, ClaimResult>;
  claimThrows: Record<string, Error>;
  conversionCalls: number;
}

function createDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    events: [],
    session: { id: SESSION_ID, user_id: ANON_ID, converted_at: null },
    sessionCharacters: [{ id: CHAR_A, user_id: ANON_ID, name: "SessionCharA" }],
    roomCharacters: [],
    claimResults: {},
    claimThrows: {},
    conversionCalls: 0,
    ...overrides,
  };
}

let deps = createDeps();

mock.module("@elizaos/cloud-shared/lib/utils/logger", () => ({
  logger: { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} },
}));

mock.module("@elizaos/cloud-shared/auth", () => ({
  requireUserWithOrg: async () => ({
    id: USER_ID,
    organization_id: ORG_ID,
  }),
}));

mock.module("@elizaos/cloud-shared/db/repositories", () => ({
  participantsRepository: {
    findRoomsByEntityId: async () => deps.roomCharacters.map(() => "room-1"),
  },
  roomsRepository: {
    findByIds: async () =>
      deps.roomCharacters.map((char) => ({ id: "room-1", agentId: char.id })),
  },
  userCharactersRepository: {
    findById: async (characterId: string) =>
      deps.roomCharacters.find((char) => char.id === characterId) ?? null,
    listByUser: async (userId: string) =>
      deps.sessionCharacters.filter((char) => char.user_id === userId),
  },
}));

mock.module("@elizaos/cloud-shared/lib/services/users", () => ({
  usersService: {
    getById: async (userId: string) => {
      if (userId === ANON_ID) {
        return {
          id: ANON_ID,
          is_anonymous: true,
          email: "anon-1@anonymous.elizacloud.ai",
        };
      }
      if (userId === OTHER_ANON_ID) {
        return {
          id: OTHER_ANON_ID,
          is_anonymous: true,
          email: "anon-2@anonymous.elizacloud.ai",
        };
      }
      return null;
    },
  },
}));

mock.module("@elizaos/cloud-shared/lib/services/anonymous-sessions", () => ({
  anonymousSessionsService: {
    getByToken: async () => deps.session,
    markConverted: async (sessionId: string) => {
      deps.conversionCalls += 1;
      deps.events.push(`converted:${sessionId}`);
    },
  },
}));

mock.module("@elizaos/cloud-shared/lib/services/characters/characters", () => ({
  charactersService: {
    claimAffiliateCharacter: async (
      characterId: string,
    ): Promise<ClaimResult> => {
      const thrown = deps.claimThrows[characterId];
      if (thrown) {
        deps.events.push(`claim-threw:${characterId}`);
        throw thrown;
      }
      deps.events.push(`claim:${characterId}`);
      return (
        deps.claimResults[characterId] ?? { success: true, message: "claimed" }
      );
    },
  },
}));

const { default: claimApp } = await import(
  "../my-agents/claim-affiliate-characters/route"
);

interface ClaimResponse {
  success: boolean;
  claimed: Array<{ id: string; name: string }>;
  failed?: Array<{ id: string; reason: string }>;
  sessionRetryable?: boolean;
  message: string;
}

async function parseClaimResponse(response: Response): Promise<ClaimResponse> {
  return (await response.json()) as ClaimResponse;
}

function postWithSessionToken() {
  return claimApp.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionToken: SESSION_TOKEN }),
  });
}

describe("POST /api/my-agents/claim-affiliate-characters session conversion ordering", () => {
  test("a returned claim failure keeps the session unconverted and retryable", async () => {
    deps = createDeps({
      claimResults: {
        [CHAR_A]: { success: false, message: "temporary database failure" },
      },
    });

    const response = await postWithSessionToken();
    const body = await parseClaimResponse(response);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      claimed: [],
      failed: [{ id: CHAR_A, reason: "temporary database failure" }],
      sessionRetryable: true,
      message: "No characters were claimed",
    });
    expect(deps.events).toEqual([`claim:${CHAR_A}`]);
    expect(deps.conversionCalls).toBe(0);
  });

  test("a thrown claim failure keeps the session retryable and degrades page-safe", async () => {
    deps = createDeps({
      claimThrows: { [CHAR_A]: new Error("transient storage outage") },
    });

    const response = await postWithSessionToken();
    const body = await parseClaimResponse(response);

    expect(response.status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.message).toContain("could not complete");
    expect(deps.events).toEqual([`claim-threw:${CHAR_A}`]);
    expect(deps.conversionCalls).toBe(0);
  });

  test("all session-backed claims succeed before conversion runs exactly once", async () => {
    deps = createDeps({
      sessionCharacters: [
        { id: CHAR_A, user_id: ANON_ID, name: "SessionCharA" },
        { id: CHAR_B, user_id: ANON_ID, name: "SessionCharB" },
      ],
    });

    const response = await postWithSessionToken();
    const body = await parseClaimResponse(response);

    expect(response.status).toBe(200);
    expect(body.claimed).toEqual([
      { id: CHAR_A, name: "SessionCharA" },
      { id: CHAR_B, name: "SessionCharB" },
    ]);
    expect(deps.events).toEqual([
      `claim:${CHAR_A}`,
      `claim:${CHAR_B}`,
      `converted:${SESSION_ID}`,
    ]);
    expect(deps.conversionCalls).toBe(1);
    expect(body.sessionRetryable).toBe(false);
  });

  test("a partial session-backed success keeps the session retryable", async () => {
    deps = createDeps({
      sessionCharacters: [
        { id: CHAR_A, user_id: ANON_ID, name: "SessionCharA" },
        { id: CHAR_B, user_id: ANON_ID, name: "SessionCharB" },
      ],
      claimResults: {
        [CHAR_B]: { success: false, message: "temporary database failure" },
      },
    });

    const response = await postWithSessionToken();
    const body = await parseClaimResponse(response);

    expect(response.status).toBe(200);
    expect(body.claimed).toEqual([{ id: CHAR_A, name: "SessionCharA" }]);
    expect(body.failed).toEqual([
      { id: CHAR_B, reason: "temporary database failure" },
    ]);
    expect(deps.events).toEqual([`claim:${CHAR_A}`, `claim:${CHAR_B}`]);
    expect(deps.conversionCalls).toBe(0);
    // The client must keep the token, or the failed claim can never be retried.
    expect(body.sessionRetryable).toBe(true);
  });

  test("a room-discovered failure does not block conversion of a fully successful session", async () => {
    deps = createDeps({
      roomCharacters: [
        {
          id: CHAR_ROOM,
          user_id: OTHER_ANON_ID,
          name: "RoomChar",
          is_anonymous: true,
        },
      ],
      claimResults: {
        [CHAR_ROOM]: { success: false, message: "not claimable" },
      },
    });

    const response = await postWithSessionToken();
    const body = await parseClaimResponse(response);

    expect(response.status).toBe(200);
    expect(body.claimed).toEqual([{ id: CHAR_A, name: "SessionCharA" }]);
    expect(body.failed).toEqual([{ id: CHAR_ROOM, reason: "not claimable" }]);
    expect(deps.events).toEqual([
      `claim:${CHAR_ROOM}`,
      `claim:${CHAR_A}`,
      `converted:${SESSION_ID}`,
    ]);
    expect(deps.conversionCalls).toBe(1);
    expect(body.sessionRetryable).toBe(false);
  });

  test("an empty session converts without any claim attempt", async () => {
    deps = createDeps({ sessionCharacters: [] });

    const response = await postWithSessionToken();
    const body = await parseClaimResponse(response);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      claimed: [],
      message: "No affiliate characters to claim",
    });
    expect(deps.events).toEqual([`converted:${SESSION_ID}`]);
    expect(deps.conversionCalls).toBe(1);
  });

  test("an already converted session is neither claimed nor converted again", async () => {
    deps = createDeps({
      session: {
        id: SESSION_ID,
        user_id: ANON_ID,
        converted_at: "2026-10-03T00:00:00.000Z",
      },
    });

    const response = await postWithSessionToken();
    const body = await parseClaimResponse(response);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      claimed: [],
      message: "No affiliate characters to claim",
    });
    expect(deps.events).toEqual([]);
    expect(deps.conversionCalls).toBe(0);
  });
});
