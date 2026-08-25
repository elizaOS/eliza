/**
 * Unit tests for CharactersService.create's username handling (#13637 class,
 * completing the slice #13706 left open for name/#13761 closed for name).
 * Blank usernames are provided-but-unset and must auto-generate; a genuinely
 * invalid provided username must fail as caller error (400 ValidationError),
 * never a raw 500. Transaction traces prove automatic and explicit claims use
 * the same global advisory lock before their scan/check and insert;
 * repositories and cache are mocked while username utilities run unmocked.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { UserCharacterCreateTransactionContract } from "../../../db/repositories/characters";
import type { NewUserCharacter } from "../../../db/schemas/user-characters";

const REPOSITORY_CREATE_REQUIRES_TRANSACTION: UserCharacterCreateTransactionContract = true;

const usernameExistsCalls: string[] = [];
const createCalls: Array<{ username?: string | null }> = [];
const characterCreateTransactions: unknown[] = [];
const agentCreateCalls: unknown[] = [];
const agentCreateTransactions: unknown[] = [];
const cacheDelCalls: string[] = [];
const transactionContexts: unknown[] = [];
const transactionConfigs: unknown[] = [];
const healthyMirrorProbeCalls: string[] = [];
const usernameScanTransactions: unknown[] = [];
const usernameExistsTransactions: unknown[] = [];
const authorityTrace: string[] = [];
const executedSql: string[] = [];

let usernameExistsResult = false;
let existingUsernames = new Set<string>();
let healthyMirrorResult = false;

const transaction = mock(
  async (
    run: (tx: { select: (fields?: Record<string, unknown>) => unknown }) => Promise<unknown>,
    config?: unknown,
  ) => {
    const tx = {
      execute: async (query: unknown) => {
        const rendered = JSON.stringify(query);
        executedSql.push(rendered);
        if (rendered.includes("set_config")) {
          authorityTrace.push("configure-timeouts");
        }
        if (rendered.includes("pg_advisory_xact_lock")) {
          authorityTrace.push("username-lock");
        }
        return { rows: [] };
      },
      select: (fields = {}) => {
        if (Object.hasOwn(fields, "creditBalance")) {
          return {
            from: () => ({
              where: () => ({
                limit: () => ({
                  for: async () => {
                    authorityTrace.push("organization-lock");
                    return [{ id: ORG_ID, creditBalance: "0.000000", settings: {} }];
                  },
                }),
              }),
            }),
          };
        }
        return {
          from: () => ({
            where: async () => [{ count: 0 }],
          }),
        };
      },
    };
    transactionContexts.push(tx);
    transactionConfigs.push(config);
    return run(tx);
  },
);

mock.module("../../../db/client", () => ({
  db: {},
  dbRead: {},
  dbWrite: { transaction },
  getDbConnectionInfo: () => ({ databaseUrlConfigured: true }),
}));

// Mock the submodule characters.ts imports through the "../../../db/repositories"
// barrel (which re-exports "./characters"), not the barrel itself — the barrel
// also re-exports unrelated repositories (apiKeysRepository, etc.) that other
// modules in the same import graph (usersService) need untouched.
mock.module("../../../db/repositories/characters", () => ({
  userCharactersRepository: {
    usernameExists: async (username: string, tx: unknown) => {
      authorityTrace.push("username-exists");
      usernameExistsCalls.push(username);
      usernameExistsTransactions.push(tx);
      return usernameExistsResult;
    },
    create: async (data: { username?: string | null }, tx: unknown) => {
      authorityTrace.push("character-insert");
      createCalls.push(data);
      characterCreateTransactions.push(tx);
      return { id: "char-1", ...data };
    },
    getAllUsernames: async (tx: unknown) => {
      authorityTrace.push("username-scan");
      usernameScanTransactions.push(tx);
      return existingUsernames;
    },
    hasHealthyCloudCharacterMirror: async (organizationId: string) => {
      healthyMirrorProbeCalls.push(organizationId);
      return healthyMirrorResult;
    },
  },
}));

mock.module("../../../db/repositories/agents/agents", () => ({
  agentsRepository: {
    create: async (agent: unknown, tx: unknown) => {
      agentCreateCalls.push(agent);
      agentCreateTransactions.push(tx);
      return true;
    },
    ensure: async () => undefined,
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
const METERED_POLICY = { policy: { mode: "metered" as const } };

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
    characterCreateTransactions.length = 0;
    agentCreateCalls.length = 0;
    agentCreateTransactions.length = 0;
    cacheDelCalls.length = 0;
    transactionContexts.length = 0;
    transactionConfigs.length = 0;
    healthyMirrorProbeCalls.length = 0;
    usernameScanTransactions.length = 0;
    usernameExistsTransactions.length = 0;
    authorityTrace.length = 0;
    executedSql.length = 0;
    transaction.mockClear();
    usernameExistsResult = false;
    existingUsernames = new Set<string>();
    healthyMirrorResult = false;
  });

  test("a healthy character+mirror probe stays read-only and opens no writer transaction", async () => {
    const { charactersService } = await import("./characters");
    healthyMirrorResult = true;

    await expect(charactersService.hasHealthyCloudCharacterMirror(ORG_ID)).resolves.toBe(true);

    expect(healthyMirrorProbeCalls).toEqual([ORG_ID]);
    expect(transaction).not.toHaveBeenCalled();
    expect(characterCreateTransactions).toHaveLength(0);
    expect(agentCreateTransactions).toHaveLength(0);
  });

  test("repository create requires and receives the authority transaction", async () => {
    const { charactersService } = await import("./characters");

    expect(REPOSITORY_CREATE_REQUIRES_TRANSACTION).toBe(true);
    await charactersService.create(baseData({ username: "transaction-bound" }), METERED_POLICY);

    expect(transactionContexts).toHaveLength(1);
    expect(characterCreateTransactions).toEqual([transactionContexts[0]]);
    expect(agentCreateTransactions).toEqual([transactionContexts[0]]);
  });

  test("empty string username auto-generates (empty-is-unset contract), no throw", async () => {
    const { charactersService } = await import("./characters");

    const character = await charactersService.create(baseData({ username: "" }), METERED_POLICY);

    expect(createCalls).toHaveLength(1);
    const created = createCalls[0];
    expect(created.username).toBeTruthy();
    expect(created.username).not.toBe("");
    expect(character.id).toBe("char-1");
  });

  test("automatic allocation takes the bounded global xact lock before scan and insert", async () => {
    const { charactersService } = await import("./characters");

    await charactersService.create(baseData({ username: null }), METERED_POLICY);

    expect(authorityTrace).toEqual([
      "organization-lock",
      "configure-timeouts",
      "username-lock",
      "username-scan",
      "character-insert",
    ]);
    expect(usernameScanTransactions).toEqual([transactionContexts[0]]);
    expect(transactionConfigs).toEqual([{ isolationLevel: "read committed" }]);
    const timeoutSql = executedSql.find((statement) => statement.includes("set_config"));
    const lockSql = executedSql.find((statement) => statement.includes("pg_advisory_xact_lock"));
    expect(timeoutSql).toContain("10000ms");
    expect(timeoutSql).toContain("30000ms");
    expect(lockSql).toContain("cloud-character");
    expect(lockSql).toContain("username-claim");
  });

  test("too-short provided username throws ValidationError -> 400, not a plain Error/500", async () => {
    const { charactersService } = await import("./characters");
    const { ApiError } = await import("../../api/cloud-worker-errors");

    let caught: unknown;
    try {
      await charactersService.create(baseData({ username: "ab" }), METERED_POLICY);
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

  test("explicit claim takes the same bounded global lock before exists and insert", async () => {
    const { charactersService } = await import("./characters");

    const character = await charactersService.create(
      baseData({ username: "Valid-Name" }),
      METERED_POLICY,
    );

    expect(usernameExistsCalls).toEqual(["valid-name"]);
    expect(authorityTrace).toEqual([
      "organization-lock",
      "configure-timeouts",
      "username-lock",
      "username-exists",
      "character-insert",
    ]);
    expect(usernameExistsTransactions).toEqual([transactionContexts[0]]);
    expect(createCalls[0].username).toBe("valid-name");
    expect(character.id).toBe("char-1");
    const lockSql = executedSql.find((statement) => statement.includes("pg_advisory_xact_lock"));
    expect(lockSql).toContain("cloud-character");
    expect(lockSql).toContain("username-claim");
  });

  test("duplicate provided username throws ValidationError -> 400, not a plain Error/500", async () => {
    const { charactersService } = await import("./characters");
    const { ApiError } = await import("../../api/cloud-worker-errors");
    usernameExistsResult = true;

    let caught: unknown;
    try {
      await charactersService.create(baseData({ username: "taken-name" }), METERED_POLICY);
    } catch (error) {
      caught = error;
    }

    expect(usernameExistsCalls).toEqual(["taken-name"]);
    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as InstanceType<typeof ApiError>;
    expect(apiError.status).toBe(400);
    expect(apiError.code).toBe("validation_error");
    expect(apiError.message).toContain("Username is already taken");
    expect(createCalls).toHaveLength(0);
  });

  test("non-string username (shape mismatch) still throws ValidationError -> 400", async () => {
    const { charactersService } = await import("./characters");
    const { ApiError } = await import("../../api/cloud-worker-errors");

    let caught: unknown;
    try {
      await charactersService.create(baseData({ username: 42 }), METERED_POLICY);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as InstanceType<typeof ApiError>;
    expect(apiError.status).toBe(400);
    expect(apiError.code).toBe("validation_error");
    expect(createCalls).toHaveLength(0);
  });

  test("missing or unknown policies fail closed before opening a transaction", async () => {
    const { charactersService } = await import("./characters");

    await expect(
      charactersService.create(baseData({ username: "valid-name" }), undefined as never),
    ).rejects.toMatchObject({ code: "CHARACTER_CREATION_POLICY_REQUIRED" });
    await expect(
      charactersService.create(baseData({ username: "valid-name" }), {
        policy: { mode: "unknown" },
      } as never),
    ).rejects.toMatchObject({ code: "CHARACTER_CREATION_POLICY_REQUIRED" });
    await expect(
      charactersService.create(baseData({ username: "valid-name" }), {
        policy: { mode: "trusted", caller: "unregistered-caller" },
      } as never),
    ).rejects.toMatchObject({ code: "CHARACTER_CREATION_POLICY_REQUIRED" });

    expect(transaction).not.toHaveBeenCalled();
    expect(createCalls).toHaveLength(0);
  });
});
