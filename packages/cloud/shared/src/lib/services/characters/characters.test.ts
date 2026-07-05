/**
 * Unit tests for CharactersService.create's username handling (#13637 class,
 * completing the slice #13706 left open for name/#13761 closed for name).
 * Blank usernames are provided-but-unset and must auto-generate; a genuinely
 * invalid provided username must fail as caller error (400 ValidationError),
 * never a raw 500. Repositories and cache are mocked; the real
 * validateUsername/generateUniqueUsername logic runs unmocked.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { NewUserCharacter } from "../../../db/schemas/user-characters";

const usernameExistsCalls: string[] = [];
const createCalls: Array<{ username?: string | null }> = [];
const agentCreateCalls: unknown[] = [];
const cacheDelCalls: string[] = [];

let usernameExistsResult = false;
let existingUsernames = new Set<string>();

// Mock the submodule characters.ts imports through the "../../../db/repositories"
// barrel (which re-exports "./characters"), not the barrel itself — the barrel
// also re-exports unrelated repositories (apiKeysRepository, etc.) that other
// modules in the same import graph (usersService) need untouched.
mock.module("../../../db/repositories/characters", () => ({
  userCharactersRepository: {
    usernameExists: async (username: string) => {
      usernameExistsCalls.push(username);
      return usernameExistsResult;
    },
    create: async (data: { username?: string | null }) => {
      createCalls.push(data);
      return { id: "char-1", ...data };
    },
    getAllUsernames: async () => existingUsernames,
  },
}));

mock.module("../../../db/repositories/agents/agents", () => ({
  agentsRepository: {
    create: async (agent: unknown) => {
      agentCreateCalls.push(agent);
      return true;
    },
  },
}));

mock.module("../../cache/client", () => ({
  cache: {
    del: async (key: string) => {
      cacheDelCalls.push(key);
    },
  },
}));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

function baseData(overrides: Record<string, unknown> = {}): NewUserCharacter {
  return {
    organization_id: ORG_ID,
    user_id: USER_ID,
    name: "Test Character",
    bio: ["A test character"],
    character_data: {},
    ...overrides,
  } as never;
}

describe("CharactersService.create — username handling (#13637 class)", () => {
  beforeEach(() => {
    usernameExistsCalls.length = 0;
    createCalls.length = 0;
    agentCreateCalls.length = 0;
    cacheDelCalls.length = 0;
    usernameExistsResult = false;
    existingUsernames = new Set<string>();
  });

  test("empty string username auto-generates (empty-is-unset contract), no throw", async () => {
    const { charactersService } = await import("./characters");

    const character = await charactersService.create(baseData({ username: "" }));

    expect(createCalls).toHaveLength(1);
    const created = createCalls[0];
    expect(created.username).toBeTruthy();
    expect(created.username).not.toBe("");
    expect(character.id).toBe("char-1");
  });

  test("too-short provided username throws ValidationError -> 400, not a plain Error/500", async () => {
    const { charactersService } = await import("./characters");
    const { ApiError } = await import("../../api/cloud-worker-errors");

    let caught: unknown;
    try {
      await charactersService.create(baseData({ username: "ab" }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as InstanceType<typeof ApiError>;
    expect(apiError.status).toBe(400);
    expect(apiError.code).toBe("validation_error");
    expect(apiError.message).toContain("Invalid username");
    expect(createCalls).toHaveLength(0);
  });

  test("valid provided username is normalized, checked for uniqueness, and used as-is", async () => {
    const { charactersService } = await import("./characters");

    const character = await charactersService.create(baseData({ username: "Valid-Name" }));

    expect(usernameExistsCalls).toEqual(["valid-name"]);
    expect(createCalls[0].username).toBe("valid-name");
    expect(character.id).toBe("char-1");
  });

  test("non-string username (shape mismatch) still throws ValidationError -> 400", async () => {
    const { charactersService } = await import("./characters");
    const { ApiError } = await import("../../api/cloud-worker-errors");

    let caught: unknown;
    try {
      await charactersService.create(baseData({ username: 42 }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as InstanceType<typeof ApiError>;
    expect(apiError.status).toBe(400);
    expect(apiError.code).toBe("validation_error");
    expect(createCalls).toHaveLength(0);
  });
});
