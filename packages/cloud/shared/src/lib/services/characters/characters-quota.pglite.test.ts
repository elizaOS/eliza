/**
 * Real-PGlite proof for the Cloud-character creation authority. The suite
 * drives the real service, repositories, transaction, quota resolver, and
 * character/runtime-mirror tables; Redis is the only substituted boundary.
 * PGlite's single writer is not the lock proof: the mocked service trace
 * separately enforces advisory-lock-before-exists/scan ordering.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { and, eq, sql } from "drizzle-orm";
import { agentTable } from "../../../db/schemas/eliza";
import {
  organizationBalanceRevisionSequence,
  organizations,
} from "../../../db/schemas/organizations";
import { userCharacters } from "../../../db/schemas/user-characters";
import { users } from "../../../db/schemas/users";
import { generateUniqueUsername, generateUsernameFromName } from "../../utils/agent-username";

const PGLITE_TIMEOUT = 60_000;
const FREE_TIER_LIMIT = 5;

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let CharactersService: typeof import("./characters").CharactersService;
let CloudCharacterQuotaExceededError: typeof import("./characters").CloudCharacterQuotaExceededError;

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedOrganization(): Promise<string> {
  const [organization] = await dbWrite
    .insert(organizations)
    .values({
      name: unique("org"),
      slug: unique("org"),
      credit_balance: "0.000000",
      settings: {},
    })
    .returning();
  return organization.id;
}

async function seedUser(organizationId: string): Promise<string> {
  const [user] = await dbWrite
    .insert(users)
    .values({
      steward_user_id: unique("steward"),
      organization_id: organizationId,
    })
    .returning();
  return user.id;
}

async function seedCloudPopulation(
  organizationId: string,
  userId: string,
  count: number,
): Promise<void> {
  if (count === 0) return;
  await dbWrite.insert(userCharacters).values(
    Array.from({ length: count }, (_, index) => ({
      organization_id: organizationId,
      user_id: userId,
      name: `Seed ${index}`,
      username: unique("seed"),
      bio: ["seed"],
      character_data: {},
      source: "cloud",
    })),
  );
}

async function cloudCount(organizationId: string): Promise<number> {
  const [row] = await dbWrite
    .select({ count: sql<number>`count(*)::int` })
    .from(userCharacters)
    .where(
      and(eq(userCharacters.organization_id, organizationId), eq(userCharacters.source, "cloud")),
    );
  return Number(row?.count ?? 0);
}

async function mirrorCount(characterId: string): Promise<number> {
  const rows = await dbWrite
    .select({ id: agentTable.id })
    .from(agentTable)
    .where(eq(agentTable.id, characterId));
  return rows.length;
}

function characterData(organizationId: string, userId: string, name: string) {
  return {
    organization_id: organizationId,
    user_id: userId,
    name,
    username: unique("character"),
    bio: [name],
    character_data: {},
    source: "cloud",
  } as const;
}

function automaticCharacterData(organizationId: string, userId: string, name: string) {
  return {
    organization_id: organizationId,
    user_id: userId,
    name,
    bio: [name],
    character_data: {},
    source: "cloud",
  } as const;
}

function releaseTogether<T>(attempts: Array<() => Promise<T>>): Promise<PromiseSettledResult<T>[]> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = attempts.map(async (attempt) => {
    await gate;
    return attempt();
  });
  release();
  return Promise.allSettled(running);
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  ({ CharactersService, CloudCharacterQuotaExceededError } = await import("./characters"));

  const { apply } = await pushSchema(
    {
      organizations,
      organizationBalanceRevisionSequence,
      users,
      userCharacters,
      agentTable,
    } as never,
    dbWrite as never,
  );
  await apply();
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("CharactersService.create — atomic Cloud-character authority", () => {
  test(
    "metered success returns the quota decision from the locked transaction",
    async () => {
      const organizationId = await seedOrganization();
      const userId = await seedUser(organizationId);
      await seedCloudPopulation(organizationId, userId, 2);
      const service = new CharactersService();

      const receipt = await service.createWithReceipt(
        characterData(organizationId, userId, "Receipt"),
        { policy: { mode: "metered" } },
      );

      expect(receipt.created).toBe(true);
      expect(receipt.quota).toEqual({
        currentBefore: 2,
        currentAfter: 3,
        limit: FREE_TIER_LIMIT,
        limitSource: "organizations.credit_balance",
      });
      expect(await cloudCount(organizationId)).toBe(3);
      expect(await mirrorCount(receipt.character.id)).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "limit - 1 plus two released creates yields one success, one typed rejection, and one mirror",
    async () => {
      const organizationId = await seedOrganization();
      const userId = await seedUser(organizationId);
      await seedCloudPopulation(organizationId, userId, FREE_TIER_LIMIT - 1);
      const service = new CharactersService();

      const results = await releaseTogether([
        () =>
          service.create(characterData(organizationId, userId, "Concurrent A"), {
            policy: { mode: "metered" },
          }),
        () =>
          service.create(characterData(organizationId, userId, "Concurrent B"), {
            policy: { mode: "metered" },
          }),
      ]);

      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.create>>> =>
          result.status === "fulfilled",
      );
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(CloudCharacterQuotaExceededError);
      expect(rejected[0].reason).toMatchObject({
        code: "CLOUD_CHARACTER_QUOTA_EXCEEDED",
        current: FREE_TIER_LIMIT,
        limit: FREE_TIER_LIMIT,
      });
      expect(await cloudCount(organizationId)).toBe(FREE_TIER_LIMIT);
      expect(await mirrorCount(fulfilled[0].value.id)).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "capacity is organization-scoped when capped A and limit - 1 B create together",
    async () => {
      const organizationA = await seedOrganization();
      const userA = await seedUser(organizationA);
      const organizationB = await seedOrganization();
      const userB = await seedUser(organizationB);
      await seedCloudPopulation(organizationA, userA, FREE_TIER_LIMIT);
      await seedCloudPopulation(organizationB, userB, FREE_TIER_LIMIT - 1);
      const service = new CharactersService();

      const [resultA, resultB] = await releaseTogether([
        () =>
          service.create(characterData(organizationA, userA, "Org A"), {
            policy: { mode: "metered" },
          }),
        () =>
          service.create(characterData(organizationB, userB, "Org B"), {
            policy: { mode: "metered" },
          }),
      ]);

      expect(resultA.status).toBe("rejected");
      if (resultA.status === "rejected") {
        expect(resultA.reason).toBeInstanceOf(CloudCharacterQuotaExceededError);
      }
      expect(resultB.status).toBe("fulfilled");
      expect(await cloudCount(organizationA)).toBe(FREE_TIER_LIMIT);
      expect(await cloudCount(organizationB)).toBe(FREE_TIER_LIMIT);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "concurrent bootstrap ensures converge on one character and one runtime mirror",
    async () => {
      const organizationId = await seedOrganization();
      const userId = await seedUser(organizationId);
      const service = new CharactersService();
      const defaultData = characterData(organizationId, userId, "Default Eliza");

      const results = await releaseTogether([
        () => service.create(defaultData, { policy: { mode: "bootstrap" } }),
        () => service.create(defaultData, { policy: { mode: "bootstrap" } }),
      ]);

      expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      const ids = results.map((result) =>
        result.status === "fulfilled" ? result.value.id : "rejected",
      );
      expect(new Set(ids).size).toBe(1);
      expect(await cloudCount(organizationId)).toBe(1);
      expect(await mirrorCount(ids[0])).toBe(1);
      expect(await service.hasHealthyCloudCharacterMirror(organizationId)).toBe(true);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "cross-org concurrent bootstraps allocate distinct automatic usernames and mirrors",
    async () => {
      const organizationA = await seedOrganization();
      const userA = await seedUser(organizationA);
      const organizationB = await seedOrganization();
      const userB = await seedUser(organizationB);
      const service = new CharactersService();
      const sharedName = unique("Cross Org Default");
      const baseUsername = generateUsernameFromName(sharedName);
      const suffixedUsername = generateUniqueUsername(baseUsername, new Set([baseUsername]));

      const results = await releaseTogether([
        () =>
          service.create(automaticCharacterData(organizationA, userA, sharedName), {
            policy: { mode: "bootstrap" },
          }),
        () =>
          service.create(automaticCharacterData(organizationB, userB, sharedName), {
            policy: { mode: "bootstrap" },
          }),
      ]);

      expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      const created = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      expect(created).toHaveLength(2);
      expect(new Set(created.map((character) => character.username)).size).toBe(2);
      expect(created.map((character) => character.username).sort()).toEqual(
        [baseUsername, suffixedUsername].sort(),
      );
      expect(await cloudCount(organizationA)).toBe(1);
      expect(await cloudCount(organizationB)).toBe(1);
      expect(await mirrorCount(created[0].id)).toBe(1);
      expect(await mirrorCount(created[1].id)).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "cross-org automatic and explicit claims converge without a raw unique failure",
    async () => {
      const explicitOrganization = await seedOrganization();
      const explicitUser = await seedUser(explicitOrganization);
      const automaticOrganization = await seedOrganization();
      const automaticUser = await seedUser(automaticOrganization);
      const service = new CharactersService();
      const sharedName = unique("Mixed Claim");
      const baseUsername = generateUsernameFromName(sharedName);
      const suffixedUsername = generateUniqueUsername(baseUsername, new Set([baseUsername]));

      const results = await releaseTogether([
        () =>
          service.create(
            {
              ...automaticCharacterData(explicitOrganization, explicitUser, sharedName),
              username: baseUsername,
            },
            { policy: { mode: "bootstrap" } },
          ),
        () =>
          service.create(automaticCharacterData(automaticOrganization, automaticUser, sharedName), {
            policy: { mode: "bootstrap" },
          }),
      ]);

      const fulfilled = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      const rejected = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      expect(fulfilled.length + rejected.length).toBe(2);
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      expect(new Set(fulfilled.map((character) => character.username)).size).toBe(fulfilled.length);
      if (fulfilled.length === 2) {
        expect(fulfilled.map((character) => character.username).sort()).toEqual(
          [baseUsername, suffixedUsername].sort(),
        );
      } else {
        expect(rejected).toHaveLength(1);
        expect(rejected[0]).toMatchObject({
          status: 400,
          code: "validation_error",
          message: "Username is already taken",
        });
      }
      expect(await cloudCount(explicitOrganization)).toBe(
        fulfilled.some((character) => character.organization_id === explicitOrganization) ? 1 : 0,
      );
      expect(await cloudCount(automaticOrganization)).toBe(
        fulfilled.some((character) => character.organization_id === automaticOrganization) ? 1 : 0,
      );
      for (const character of fulfilled) {
        expect(await mirrorCount(character.id)).toBe(1);
      }
    },
    PGLITE_TIMEOUT,
  );

  test(
    "concurrent bootstrap repairs one legacy character without duplicating its mirror",
    async () => {
      const organizationId = await seedOrganization();
      const userId = await seedUser(organizationId);
      const [legacyCharacter] = await dbWrite
        .insert(userCharacters)
        .values(characterData(organizationId, userId, "Legacy Eliza"))
        .returning();
      expect(await mirrorCount(legacyCharacter.id)).toBe(0);

      const service = new CharactersService();
      expect(await service.hasHealthyCloudCharacterMirror(organizationId)).toBe(false);
      const { logger } = await import("../../utils/logger");
      const warnSpy = spyOn(logger, "warn").mockImplementation(() => undefined);
      const defaultData = characterData(organizationId, userId, "Default Eliza");
      try {
        const results = await releaseTogether([
          () => service.create(defaultData, { policy: { mode: "bootstrap" } }),
          () => service.create(defaultData, { policy: { mode: "bootstrap" } }),
        ]);

        expect(results.every((result) => result.status === "fulfilled")).toBe(true);
        const ids = results.map((result) =>
          result.status === "fulfilled" ? result.value.id : "rejected",
        );
        expect(new Set(ids)).toEqual(new Set([legacyCharacter.id]));
        expect(await cloudCount(organizationId)).toBe(1);
        expect(await mirrorCount(legacyCharacter.id)).toBe(1);
        expect(await service.hasHealthyCloudCharacterMirror(organizationId)).toBe(true);
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    },
    PGLITE_TIMEOUT,
  );

  test(
    "named trusted caller remains exempt at the cap while joining the canonical population",
    async () => {
      const organizationId = await seedOrganization();
      const userId = await seedUser(organizationId);
      await seedCloudPopulation(organizationId, userId, FREE_TIER_LIMIT);
      const service = new CharactersService();

      const created = await service.create(characterData(organizationId, userId, "Trusted"), {
        policy: {
          mode: "trusted",
          caller: "service-api-v1-agents",
        },
      });

      expect(await cloudCount(organizationId)).toBe(FREE_TIER_LIMIT + 1);
      expect(await mirrorCount(created.id)).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a mirror conflict rolls the character insert back in the same transaction",
    async () => {
      const organizationId = await seedOrganization();
      const userId = await seedUser(organizationId);
      const characterId = crypto.randomUUID();
      await dbWrite.insert(agentTable).values({
        id: characterId,
        name: "Pre-existing mirror",
      });
      const service = new CharactersService();

      await expect(
        service.create(
          {
            ...characterData(organizationId, userId, "Mirror conflict"),
            id: characterId,
          },
          {
            policy: {
              mode: "trusted",
              caller: "affiliate-create-character",
            },
          },
        ),
      ).rejects.toMatchObject({ code: "CHARACTER_AGENT_MIRROR_CONFLICT" });

      const persisted = await dbWrite
        .select({ id: userCharacters.id })
        .from(userCharacters)
        .where(eq(userCharacters.id, characterId));
      expect(persisted).toHaveLength(0);
      expect(await mirrorCount(characterId)).toBe(1);
    },
    PGLITE_TIMEOUT,
  );
});
