/**
 * acceptInvite owner dead-end (#11332).
 *
 * Every self-signup provisions the new user as the OWNER of a fresh solo org
 * (steward-sync `role: "owner"`), and `acceptInvite` blanket-rejects owners
 * ("Organization owners cannot join other organizations"). Net effect: org
 * invites only ever work for people who have NEVER signed up — any teammate
 * with an existing Eliza Cloud account is permanently locked out of joining
 * their team.
 *
 * These cases run the REAL `InvitesService.acceptInvite` against in-process
 * PGlite (real users/organizations/invites SQL, real drizzle relational reads).
 * Case 1 is the bug proof: it FAILS on the blanket owner block and passes only
 * when a sole-member owner of an empty solo org can accept — moved into the
 * inviting org with the invited role, characters + conversations re-homed, and
 * the vacated solo org deleted. The remaining cases pin the boundary: owners
 * whose org has other members, deployed apps/agents/domains, or more credits
 * than the signup grant stay blocked with actionable errors.
 *
 * Fails loudly (via the `pgliteReady` guard) if PGlite/pushSchema ever fails
 * to initialize — never a silent skip.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

// This proof owns its DB: force an isolated in-memory PGlite regardless of the
// ambient DATABASE_URL / TEST_DATABASE_URL the CI lane exports.
process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

// Not the seam under test: `invites.ts` imports the email service at module
// level for createInvite's notification. acceptInvite never sends mail.
mock.module("../email", () => ({
  emailService: {
    sendInviteEmail: mock(async () => false),
  },
}));

const PGLITE_TIMEOUT = 60_000;

let pgliteReady = true;
let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let invitesService: typeof import("../invites").invitesService;
let generateInviteToken: typeof import("../../utils/invite-tokens").generateInviteToken;
let hashInviteToken: typeof import("../../utils/invite-tokens").hashInviteToken;
let schemas: {
  organizations: typeof import("../../../db/schemas/organizations").organizations;
  users: typeof import("../../../db/schemas/users").users;
  organizationInvites: typeof import("../../../db/schemas/organization-invites").organizationInvites;
  userCharacters: typeof import("../../../db/schemas/user-characters").userCharacters;
  conversations: typeof import("../../../db/schemas/conversations").conversations;
  apps: typeof import("../../../db/schemas/apps").apps;
  containers: typeof import("../../../db/schemas/containers").containers;
  agentSandboxes: typeof import("../../../db/schemas/agent-sandboxes").agentSandboxes;
  managedDomains: typeof import("../../../db/schemas/managed-domains").managedDomains;
};

let seq = 0;
function uid(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

interface SeedResult {
  inviterOrgId: string;
  inviterUserId: string;
  inviteeOrgId: string;
  inviteeUserId: string;
  inviteId: string;
  token: string;
}

/**
 * Seeds an inviting org (owner = inviter) plus an invitee who already owns a
 * solo org, and a pending invite addressed to the invitee's email.
 */
async function seedInviteScenario(options?: {
  inviteeOrgBalance?: string;
  invitedRole?: "admin" | "member";
}): Promise<SeedResult> {
  const inviterOrgId = uid();
  const inviterUserId = uid();
  const inviteeOrgId = uid();
  const inviteeUserId = uid();
  const inviteeEmail = `invitee-${inviteeUserId}@example.com`;

  await dbWrite.insert(schemas.organizations).values([
    { id: inviterOrgId, name: "Team Org", slug: `team-${inviterOrgId}` },
    {
      id: inviteeOrgId,
      name: "Solo Org",
      slug: `solo-${inviteeOrgId}`,
      credit_balance: options?.inviteeOrgBalance ?? "5.000000",
    },
  ]);
  await dbWrite.insert(schemas.users).values([
    {
      id: inviterUserId,
      steward_user_id: `steward-${inviterUserId}`,
      email: `inviter-${inviterUserId}@example.com`,
      organization_id: inviterOrgId,
      role: "owner",
    },
    {
      id: inviteeUserId,
      steward_user_id: `steward-${inviteeUserId}`,
      email: inviteeEmail,
      organization_id: inviteeOrgId,
      role: "owner",
    },
  ]);

  const token = generateInviteToken();
  const inviteId = uid();
  await dbWrite.insert(schemas.organizationInvites).values({
    id: inviteId,
    organization_id: inviterOrgId,
    inviter_user_id: inviterUserId,
    invited_email: inviteeEmail,
    invited_role: options?.invitedRole ?? "member",
    token_hash: hashInviteToken(token),
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
    status: "pending",
  });

  return {
    inviterOrgId,
    inviterUserId,
    inviteeOrgId,
    inviteeUserId,
    inviteId,
    token,
  };
}

async function readUser(userId: string): Promise<{ organization_id: string | null; role: string }> {
  const rows = await dbWrite.execute(
    `SELECT organization_id, role FROM users WHERE id = '${userId}';`,
  );
  return rows.rows[0] as { organization_id: string | null; role: string };
}

async function orgExists(orgId: string): Promise<boolean> {
  const rows = await dbWrite.execute(`SELECT id FROM organizations WHERE id = '${orgId}';`);
  return rows.rows.length > 0;
}

async function appExists(appId: string): Promise<boolean> {
  const rows = await dbWrite.execute(`SELECT id FROM apps WHERE id = '${appId}';`);
  return rows.rows.length > 0;
}

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ invitesService } = await import("../invites"));
    ({ generateInviteToken, hashInviteToken } = await import("../../utils/invite-tokens"));

    const { organizations } = await import("../../../db/schemas/organizations");
    const { users } = await import("../../../db/schemas/users");
    const { organizationInvites } = await import("../../../db/schemas/organization-invites");
    const { userCharacters } = await import("../../../db/schemas/user-characters");
    const { conversations } = await import("../../../db/schemas/conversations");
    const { apiKeys } = await import("../../../db/schemas/api-keys");
    const { creditTransactions } = await import("../../../db/schemas/credit-transactions");
    const { apps, appDeploymentStatusEnum, appReviewStatusEnum, userDatabaseStatusEnum } =
      await import("../../../db/schemas/apps");
    const { containers } = await import("../../../db/schemas/containers");
    const { agentSandboxes } = await import("../../../db/schemas/agent-sandboxes");
    const {
      domainModerationStatusEnum,
      domainNameserverModeEnum,
      domainRegistrarEnum,
      domainResourceTypeEnum,
      domainStatusEnum,
      managedDomains,
    } = await import("../../../db/schemas/managed-domains");
    const { mcpPricingTypeEnum, mcpStatusEnum, userMcps } = await import(
      "../../../db/schemas/user-mcps"
    );
    schemas = {
      organizations,
      users,
      organizationInvites,
      userCharacters,
      conversations,
      apps,
      containers,
      agentSandboxes,
      managedDomains,
    };

    const { pushSchema } = await import("../../../db/push-schema-for-tests");
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        organizationInvites,
        userCharacters,
        conversations,
        apiKeys,
        creditTransactions,
        apps,
        containers,
        agentSandboxes,
        managedDomains,
        domainRegistrarEnum,
        domainNameserverModeEnum,
        domainResourceTypeEnum,
        domainModerationStatusEnum,
        domainStatusEnum,
        userMcps,
        mcpPricingTypeEnum,
        mcpStatusEnum,
        appDeploymentStatusEnum,
        appReviewStatusEnum,
        userDatabaseStatusEnum,
      } as never,
      dbWrite as never,
    );
    await apply();
  } catch (error) {
    pgliteReady = false;
    console.error("[invite-owner-accept.test] PGlite/pushSchema unavailable — failing.", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("acceptInvite — existing owner of an empty solo org (#11332)", () => {
  test(
    "sole-member owner of an empty solo org CAN accept: moved with invited role, content re-homed, solo org deleted",
    async () => {
      expect(pgliteReady).toBe(true);
      const seeded = await seedInviteScenario({ invitedRole: "member" });

      // The auto-provisioned signup artifacts every solo org has: a default
      // character and a conversation. Both are user-authored content and must
      // survive the org move.
      const characterId = uid();
      await dbWrite.insert(schemas.userCharacters).values({
        id: characterId,
        organization_id: seeded.inviteeOrgId,
        user_id: seeded.inviteeUserId,
        name: "Eliza",
        bio: ["default"],
        character_data: { name: "Eliza" },
      });
      const conversationId = uid();
      await dbWrite.insert(schemas.conversations).values({
        id: conversationId,
        organization_id: seeded.inviteeOrgId,
        user_id: seeded.inviteeUserId,
        title: "hello",
        model: "test-model",
      });
      // A soft-deleted container must NOT count as a deployed agent.
      await dbWrite.insert(schemas.containers).values({
        id: uid(),
        name: "old",
        project_name: "old",
        organization_id: seeded.inviteeOrgId,
        user_id: seeded.inviteeUserId,
        status: "deleted",
      });

      const accepted = await invitesService.acceptInvite(seeded.token, seeded.inviteeUserId);

      expect(accepted.status).toBe("accepted");
      expect(accepted.accepted_by_user_id).toBe(seeded.inviteeUserId);

      const movedUser = await readUser(seeded.inviteeUserId);
      expect(movedUser.organization_id).toBe(seeded.inviterOrgId);
      expect(movedUser.role).toBe("member");

      // Vacated solo org is gone; the user's content moved with them.
      expect(await orgExists(seeded.inviteeOrgId)).toBe(false);
      const characterRows = await dbWrite.execute(
        `SELECT organization_id FROM user_characters WHERE id = '${characterId}';`,
      );
      expect((characterRows.rows[0] as { organization_id: string }).organization_id).toBe(
        seeded.inviterOrgId,
      );
      const conversationRows = await dbWrite.execute(
        `SELECT organization_id FROM conversations WHERE id = '${conversationId}';`,
      );
      expect((conversationRows.rows[0] as { organization_id: string }).organization_id).toBe(
        seeded.inviterOrgId,
      );
    },
    PGLITE_TIMEOUT,
  );

  test(
    "vacated org is not deleted if real state appears after the user move",
    async () => {
      expect(pgliteReady).toBe(true);
      const seeded = await seedInviteScenario({ invitedRole: "member" });
      const racedAppId = uid();

      const { usersService } = await import("../users");
      const originalUpdate = usersService.update;
      let injected = false;
      usersService.update = mock(async (id, data) => {
        const updated = await originalUpdate.call(usersService, id, data);
        if (id === seeded.inviteeUserId && !injected) {
          injected = true;
          await dbWrite.insert(schemas.apps).values({
            id: racedAppId,
            organization_id: seeded.inviteeOrgId,
            created_by_user_id: seeded.inviteeUserId,
            name: "race app",
            slug: `race-${seeded.inviteeOrgId}`,
            app_url: "https://example.com",
          });
        }
        return updated;
      }) as typeof usersService.update;

      try {
        const accepted = await invitesService.acceptInvite(seeded.token, seeded.inviteeUserId);

        expect(accepted.status).toBe("accepted");
        expect((await readUser(seeded.inviteeUserId)).organization_id).toBe(seeded.inviterOrgId);
        expect(await orgExists(seeded.inviteeOrgId)).toBe(true);
        expect(await appExists(racedAppId)).toBe(true);
      } finally {
        usersService.update = originalUpdate;
      }
    },
    PGLITE_TIMEOUT,
  );

  test(
    "owner of an org with another member stays blocked, user and invite untouched",
    async () => {
      expect(pgliteReady).toBe(true);
      const seeded = await seedInviteScenario();
      await dbWrite.insert(schemas.users).values({
        id: uid(),
        steward_user_id: `steward-${uid()}`,
        email: `member-${seeded.inviteeOrgId}@example.com`,
        organization_id: seeded.inviteeOrgId,
        role: "member",
      });

      await expect(invitesService.acceptInvite(seeded.token, seeded.inviteeUserId)).rejects.toThrow(
        /other members/,
      );

      const user = await readUser(seeded.inviteeUserId);
      expect(user.organization_id).toBe(seeded.inviteeOrgId);
      expect(user.role).toBe("owner");
      expect(await orgExists(seeded.inviteeOrgId)).toBe(true);
      const invite = await invitesService.getById(seeded.inviteId);
      expect(invite?.status).toBe("pending");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "owner with a deployed app stays blocked",
    async () => {
      expect(pgliteReady).toBe(true);
      const seeded = await seedInviteScenario();
      await dbWrite.insert(schemas.apps).values({
        id: uid(),
        organization_id: seeded.inviteeOrgId,
        created_by_user_id: seeded.inviteeUserId,
        name: "my app",
        slug: `app-${seeded.inviteeOrgId}`,
        app_url: "https://example.com",
      });

      await expect(invitesService.acceptInvite(seeded.token, seeded.inviteeUserId)).rejects.toThrow(
        /deployed apps, agents, or managed domains/,
      );
      expect((await readUser(seeded.inviteeUserId)).organization_id).toBe(seeded.inviteeOrgId);
      expect(await orgExists(seeded.inviteeOrgId)).toBe(true);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "owner with an active container (deployed agent) stays blocked",
    async () => {
      expect(pgliteReady).toBe(true);
      const seeded = await seedInviteScenario();
      await dbWrite.insert(schemas.containers).values({
        id: uid(),
        name: "agent",
        project_name: "agent",
        organization_id: seeded.inviteeOrgId,
        user_id: seeded.inviteeUserId,
        status: "running",
      });

      await expect(invitesService.acceptInvite(seeded.token, seeded.inviteeUserId)).rejects.toThrow(
        /deployed apps, agents, or managed domains/,
      );
      expect((await readUser(seeded.inviteeUserId)).organization_id).toBe(seeded.inviteeOrgId);
      expect(await orgExists(seeded.inviteeOrgId)).toBe(true);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "owner with a live shared agent sandbox stays blocked",
    async () => {
      expect(pgliteReady).toBe(true);
      const seeded = await seedInviteScenario();
      await dbWrite.insert(schemas.agentSandboxes).values({
        id: uid(),
        organization_id: seeded.inviteeOrgId,
        user_id: seeded.inviteeUserId,
        status: "running",
        execution_tier: "shared",
        agent_name: "shared agent",
      });

      await expect(invitesService.acceptInvite(seeded.token, seeded.inviteeUserId)).rejects.toThrow(
        /deployed apps, agents, or managed domains/,
      );
      expect((await readUser(seeded.inviteeUserId)).organization_id).toBe(seeded.inviteeOrgId);
      expect(await orgExists(seeded.inviteeOrgId)).toBe(true);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "owner with a managed domain stays blocked",
    async () => {
      expect(pgliteReady).toBe(true);
      const seeded = await seedInviteScenario();
      await dbWrite.insert(schemas.managedDomains).values({
        id: uid(),
        organizationId: seeded.inviteeOrgId,
        domain: `solo-${seeded.inviteeUserId}.example.com`,
      });

      await expect(invitesService.acceptInvite(seeded.token, seeded.inviteeUserId)).rejects.toThrow(
        /deployed apps, agents, or managed domains/,
      );
      expect((await readUser(seeded.inviteeUserId)).organization_id).toBe(seeded.inviteeOrgId);
      expect(await orgExists(seeded.inviteeOrgId)).toBe(true);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "owner whose org holds more credits than the signup grant stays blocked",
    async () => {
      expect(pgliteReady).toBe(true);
      const seeded = await seedInviteScenario({
        inviteeOrgBalance: "25.000000",
      });

      await expect(invitesService.acceptInvite(seeded.token, seeded.inviteeUserId)).rejects.toThrow(
        /credits/,
      );
      expect((await readUser(seeded.inviteeUserId)).organization_id).toBe(seeded.inviteeOrgId);
      expect(await orgExists(seeded.inviteeOrgId)).toBe(true);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "non-owner member accept keeps working and never deletes the org they leave",
    async () => {
      expect(pgliteReady).toBe(true);
      const seeded = await seedInviteScenario();
      // Reshape: the invitee is a plain member of an org that has an owner.
      await dbWrite.execute(
        `UPDATE users SET role = 'member' WHERE id = '${seeded.inviteeUserId}';`,
      );
      await dbWrite.insert(schemas.users).values({
        id: uid(),
        steward_user_id: `steward-owner-${seeded.inviteeOrgId}`,
        email: `owner-${seeded.inviteeOrgId}@example.com`,
        organization_id: seeded.inviteeOrgId,
        role: "owner",
      });

      const accepted = await invitesService.acceptInvite(seeded.token, seeded.inviteeUserId);
      expect(accepted.status).toBe("accepted");

      const user = await readUser(seeded.inviteeUserId);
      expect(user.organization_id).toBe(seeded.inviterOrgId);
      // The org they left keeps existing — it still has its owner.
      expect(await orgExists(seeded.inviteeOrgId)).toBe(true);
    },
    PGLITE_TIMEOUT,
  );
});
