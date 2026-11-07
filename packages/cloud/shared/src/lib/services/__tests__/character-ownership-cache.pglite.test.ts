/**
 * Ownership transfers must not leave the previous owner in the character
 * cache. `charactersService.getById` serves the row from an in-isolate LRU
 * and from Redis (1h TTL); the publish and monetization routes and the hosted
 * runtime authorize against that cached `user_id` / `organization_id`. Both
 * transfer paths — claiming an affiliate character and migrating an anonymous
 * session (in place and into an existing account) — write the owner columns
 * directly, so each must evict the cached row and the cached runtime. Deleting
 * an agent deletes its linked character, which must leave the cache as well.
 *
 * Real services and schema on PGlite with the in-memory Redis adapter; only
 * the runtime-factory eviction hook is replaced by a recorder.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";

const PGLITE_DATABASE_URL = "pglite://memory";
const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
  MOCK_REDIS: process.env.MOCK_REDIS,
  SKIP_AGENT_SANDBOX_ENSURE: process.env.SKIP_AGENT_SANDBOX_ENSURE,
};
// Force both selectors before the client is imported so an ambient
// integration DSN can never receive this suite's DDL.
process.env.DATABASE_URL = PGLITE_DATABASE_URL;
process.env.TEST_DATABASE_URL = PGLITE_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { anonymousSessions } from "../../../db/schemas/anonymous-sessions";
import { conversations } from "../../../db/schemas/conversations";
import { elizaRoomCharactersTable } from "../../../db/schemas/eliza-room-characters";
import { organizationConfig } from "../../../db/schemas/organization-config";
import { organizations } from "../../../db/schemas/organizations";
import { userCharacters } from "../../../db/schemas/user-characters";
import { userIdentities } from "../../../db/schemas/user-identities";
import { users } from "../../../db/schemas/users";

type ClientModule = typeof import("../../../db/client");
type CharactersModule = typeof import("../characters");
type SessionModule = typeof import("../../session");
type InvitesModule = typeof import("../invites");
type DeletionModule = typeof import("../eliza-sandbox/lifecycle/deletion");

let dbWrite: ClientModule["dbWrite"];
let closeDatabaseConnectionsForTests: ClientModule["closeDatabaseConnectionsForTests"] | undefined;
let charactersService: CharactersModule["charactersService"];
let migrateAnonymousSession: SessionModule["migrateAnonymousSession"];
let invitesService: InvitesModule["invitesService"];
let SandboxDeletion: DeletionModule["SandboxDeletion"];
let schemaFailure = "";
const evictedRuntimes: string[] = [];
let seq = 0;

function uuid(prefix: string): string {
  seq += 1;
  return `${prefix}-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

async function insertOrganization(label: string): Promise<string> {
  const id = uuid("10000000");
  await dbWrite.insert(organizations).values({ id, name: label, slug: `${label}-${seq}` });
  return id;
}

async function insertUser(options: {
  organizationId: string | null;
  stewardUserId: string;
  email?: string;
  isAnonymous?: boolean;
}): Promise<string> {
  const id = uuid("20000000");
  await dbWrite.insert(users).values({
    id,
    steward_user_id: options.stewardUserId,
    organization_id: options.organizationId,
    email: options.email,
    is_anonymous: options.isAnonymous ?? false,
  });
  await dbWrite.insert(userIdentities).values({
    user_id: id,
    steward_user_id: options.stewardUserId,
    is_anonymous: options.isAnonymous ?? false,
  });
  return id;
}

async function insertCharacter(userId: string, organizationId: string): Promise<string> {
  const [row] = await dbWrite
    .insert(userCharacters)
    .values({
      user_id: userId,
      organization_id: organizationId,
      name: `agent-${seq}`,
      bio: "owned by an anonymous session",
      character_data: {},
    })
    .returning({ id: userCharacters.id });
  return row.id;
}

beforeAll(async () => {
  try {
    const [
      clientModule,
      charactersModule,
      sessionModule,
      registryModule,
      invitesModule,
      deletionModule,
    ] = await Promise.all([
      import("../../../db/client"),
      import("../characters"),
      import("../../session"),
      import("../../eliza/runtime-cache-registry"),
      import("../invites"),
      import("../eliza-sandbox/lifecycle/deletion"),
    ]);
    dbWrite = clientModule.dbWrite;
    closeDatabaseConnectionsForTests = clientModule.closeDatabaseConnectionsForTests;
    charactersService = charactersModule.charactersService;
    migrateAnonymousSession = sessionModule.migrateAnonymousSession;
    invitesService = invitesModule.invitesService;
    SandboxDeletion = deletionModule.SandboxDeletion;
    registryModule.registerRuntimeCacheActions({
      invalidateRuntime: async (agentId) => {
        evictedRuntimes.push(agentId);
        return false;
      },
      invalidateByOrganization: async () => 0,
    });
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        userIdentities,
        anonymousSessions,
        organizationConfig,
        conversations,
        userCharacters,
        elizaRoomCharactersTable,
      } as never,
      dbWrite as never,
    );
    await apply();
    // migrateAnonymousSession re-points plugin-sql participants; only the
    // columns it writes are needed here.
    await dbWrite.execute(
      sql`CREATE TABLE IF NOT EXISTS participants (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamptz NOT NULL DEFAULT now(),
        entity_id uuid,
        room_id uuid,
        agent_id uuid,
        room_state text
      )`,
    );
  } catch (error) {
    schemaFailure = error instanceof Error ? error.message : String(error);
  }
}, 120_000);

beforeEach(() => {
  expect(schemaFailure).toBe("");
  evictedRuntimes.length = 0;
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("character ownership transfers evict the cached owner", () => {
  test("claimAffiliateCharacter: getById returns the claiming user, not the cached affiliate", async () => {
    const affiliateOrg = await insertOrganization("affiliate");
    const affiliateUser = await insertUser({
      organizationId: affiliateOrg,
      stewardUserId: `affiliate-${seq}`,
      email: `affiliate-${seq}@anonymous.elizacloud.ai`,
      isAnonymous: true,
    });
    const claimerOrg = await insertOrganization("claimer");
    const claimer = await insertUser({
      organizationId: claimerOrg,
      stewardUserId: `claimer-${seq}`,
    });
    const characterId = await insertCharacter(affiliateUser, affiliateOrg);

    const warmed = await charactersService.getById(characterId);
    expect(warmed?.user_id).toBe(affiliateUser);

    const result = await charactersService.claimAffiliateCharacter(
      characterId,
      claimer,
      claimerOrg,
    );
    expect(result.success).toBe(true);

    const after = await charactersService.getById(characterId);
    expect(after?.user_id).toBe(claimer);
    expect(after?.organization_id).toBe(claimerOrg);
    expect(evictedRuntimes).toEqual([characterId]);
  });

  test("migrateAnonymousSession into an existing account: getById returns the real user", async () => {
    const anonOrg = await insertOrganization("anon");
    const anonUser = await insertUser({
      organizationId: anonOrg,
      stewardUserId: `anon-${seq}`,
      isAnonymous: true,
    });
    const realOrg = await insertOrganization("real");
    const realSteward = `real-${seq}`;
    const realUser = await insertUser({ organizationId: realOrg, stewardUserId: realSteward });
    const first = await insertCharacter(anonUser, anonOrg);
    const second = await insertCharacter(anonUser, anonOrg);

    expect((await charactersService.getById(first))?.user_id).toBe(anonUser);
    expect((await charactersService.getById(second))?.user_id).toBe(anonUser);

    const result = await migrateAnonymousSession(anonUser, realSteward);
    expect(result.mergedData.charactersTransferred).toBe(2);

    for (const id of [first, second]) {
      const after = await charactersService.getById(id);
      expect(after?.user_id).toBe(realUser);
      expect(after?.organization_id).toBe(realOrg);
    }
    expect([...evictedRuntimes].sort()).toEqual([first, second].sort());
    const [gone] = await dbWrite.select().from(users).where(eq(users.id, anonUser));
    expect(gone).toBeUndefined();
  });

  test("migrateAnonymousSession in place: getById returns the new organization", async () => {
    const anonOrg = await insertOrganization("inplace");
    const anonUser = await insertUser({
      organizationId: anonOrg,
      stewardUserId: `inplace-${seq}`,
      isAnonymous: true,
    });
    const characterId = await insertCharacter(anonUser, anonOrg);

    expect((await charactersService.getById(characterId))?.organization_id).toBe(anonOrg);

    await migrateAnonymousSession(anonUser, `new-steward-${seq}`);

    const [userRow] = await dbWrite.select().from(users).where(eq(users.id, anonUser));
    expect(userRow.organization_id).not.toBe(anonOrg);
    const after = await charactersService.getById(characterId);
    expect(after?.user_id).toBe(anonUser);
    expect(after?.organization_id).toBe(userRow.organization_id);
    expect(evictedRuntimes).toEqual([characterId]);
  });

  describe("solo-organization re-home after an invite accept", () => {
    // The org-vacate check and the org delete read tables outside this schema;
    // they are recorded here so the re-home order can be checked.
    const steps: string[] = [];
    let restore: Array<() => void> = [];

    beforeEach(async () => {
      steps.length = 0;
      const { organizationsService } = await import("../organizations");
      const vacate = spyOn(
        invitesService as unknown as {
          assertOwnerCanVacateSoloOrganization(a: string, b: string): Promise<void>;
        },
        "assertOwnerCanVacateSoloOrganization",
      ).mockImplementation(async () => {
        steps.push("vacate-check");
      });
      const remove = spyOn(organizationsService, "delete").mockImplementation(async () => {
        steps.push("org-delete");
      });
      restore = [() => vacate.mockRestore(), () => remove.mockRestore()];
    });

    afterEach(() => {
      for (const undo of restore) undo();
    });

    async function cleanUp(owner: string, from: string, to: string): Promise<void> {
      await (
        invitesService as unknown as {
          cleanUpVacatedSoloOrganization(a: string, b: string, c: string): Promise<void>;
        }
      ).cleanUpVacatedSoloOrganization(owner, from, to);
    }

    test("getById returns the new organization after the re-home", async () => {
      const soloOrg = await insertOrganization("solo");
      const owner = await insertUser({ organizationId: soloOrg, stewardUserId: `solo-${seq}` });
      const invitingOrg = await insertOrganization("inviting");
      const characterId = await insertCharacter(owner, soloOrg);
      expect((await charactersService.getById(characterId))?.organization_id).toBe(soloOrg);

      await dbWrite.update(users).set({ organization_id: invitingOrg }).where(eq(users.id, owner));
      await cleanUp(owner, soloOrg, invitingOrg);

      expect(steps).toEqual(["vacate-check", "org-delete"]);
      expect((await charactersService.getById(characterId))?.organization_id).toBe(invitingOrg);
      expect(evictedRuntimes).toEqual([characterId]);
    });

    test("a cache failure does not stop the conversation re-home or the org delete", async () => {
      const soloOrg = await insertOrganization("solo-cache");
      const owner = await insertUser({
        organizationId: soloOrg,
        stewardUserId: `solo-cache-${seq}`,
      });
      const invitingOrg = await insertOrganization("inviting-cache");
      await insertCharacter(owner, soloOrg);
      const [conversation] = await dbWrite
        .insert(conversations)
        .values({
          user_id: owner,
          organization_id: soloOrg,
          title: "kept",
          model: "gpt-4o-mini",
        } as never)
        .returning({ id: conversations.id });
      const cacheDown = spyOn(charactersService, "invalidateCache").mockImplementation(async () => {
        throw new Error("cache unavailable");
      });
      try {
        await dbWrite
          .update(users)
          .set({ organization_id: invitingOrg })
          .where(eq(users.id, owner));
        await cleanUp(owner, soloOrg, invitingOrg);
      } finally {
        cacheDown.mockRestore();
      }

      expect(steps).toEqual(["vacate-check", "org-delete"]);
      const [moved] = await dbWrite
        .select({ organization_id: conversations.organization_id })
        .from(conversations)
        .where(eq(conversations.id, conversation.id));
      expect(moved.organization_id).toBe(invitingOrg);
    });
  });
});

describe("agent deletion evicts the linked character", () => {
  test("executeDeletion: getById no longer serves the deleted character", async () => {
    const orgId = await insertOrganization("deleted-agent");
    const userId = await insertUser({ organizationId: orgId, stewardUserId: `owner-${seq}` });
    const characterId = await insertCharacter(userId, orgId);
    expect((await charactersService.getById(characterId))?.id).toBe(characterId);

    // Only the sandbox teardown is replaced; the linked character cleanup
    // after it runs against the real service and schema.
    const deletion = new SandboxDeletion({
      getAgentForWrite: async () => undefined,
    } as never);
    spyOn(deletion, "deleteAgent").mockResolvedValue({
      success: true,
      rowDeleted: true,
      deletedSandbox: { character_id: characterId, agent_config: {} },
    } as never);

    const result = await deletion.executeDeletion("agent-1", orgId);

    expect(result.rowDeleted).toBe(true);
    const [row] = await dbWrite
      .select({ id: userCharacters.id })
      .from(userCharacters)
      .where(eq(userCharacters.id, characterId));
    expect(row).toBeUndefined();
    expect(await charactersService.getById(characterId)).toBeUndefined();
    expect(evictedRuntimes).toContain(characterId);
  });
});
