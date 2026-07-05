/**
 * Invited users must end up with a working personal default API key — the same
 * "Default API Key" a direct signup mints (the #11270 launch-blocker family:
 * an account ending up with no usable key, so inference is dead on arrival).
 *
 * Both invite-accept surfaces used to skip the mint:
 * - `invitesService.acceptInvite` moves an existing user into the inviting
 *   org; their old default key belongs to the org they left (and is
 *   cascade-deleted with a vacated solo org), leaving them keyless.
 * - `syncUserFromSteward`'s pending-invite branch creates a brand-new user
 *   directly in the inviting org and returns before the default provisioning
 *   the direct-signup branch runs.
 *
 * These cases run the REAL services against in-process PGlite (real users/
 * organizations/invites/api_keys SQL, real drizzle relational reads, and the
 * real api-key mint through the memory KMS adapter). The Discord/email
 * notification modules are mocked — network side effects, not the seam under
 * test. Fails loudly (via the `pgliteReady` guard) if PGlite/pushSchema ever
 * fails to initialize — never a silent skip.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import crypto from "node:crypto";

// This proof owns its DB: force an isolated in-memory PGlite regardless of the
// ambient DATABASE_URL / TEST_DATABASE_URL the CI lane exports.
process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

// Not the seams under test: invites.ts imports the email service at module
// level for createInvite's notification, and steward-sync fire-and-forgets a
// Discord signup embed. Both would hit the network.
mock.module("../email", () => ({
  emailService: {
    sendInviteEmail: mock(async () => false),
    sendWelcomeEmail: mock(async () => false),
  },
}));
mock.module("../discord", () => ({
  discordService: {
    logUserSignup: mock(async () => true),
  },
}));

const PGLITE_TIMEOUT = 60_000;

let pgliteReady = true;
let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let apiKeysService: typeof import("../api-keys").apiKeysService;
let invitesService: typeof import("../invites").invitesService;
let syncUserFromSteward: typeof import("../../steward-sync").syncUserFromSteward;
let generateInviteToken: typeof import("../../utils/invite-tokens").generateInviteToken;
let hashInviteToken: typeof import("../../utils/invite-tokens").hashInviteToken;
let schemas: {
  organizations: typeof import("../../../db/schemas/organizations").organizations;
  users: typeof import("../../../db/schemas/users").users;
  organizationInvites: typeof import("../../../db/schemas/organization-invites").organizationInvites;
  apiKeys: typeof import("../../../db/schemas/api-keys").apiKeys;
};

let seq = 0;
function uid(): string {
  seq += 1;
  return `00000000-0000-4000-9000-${String(seq).padStart(12, "0")}`;
}

function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

interface SeedResult {
  inviterOrgId: string;
  inviterUserId: string;
  inviteeOrgId: string;
  inviteeUserId: string;
  inviteeEmail: string;
  inviteeOldApiKey: string;
  token: string;
}

/**
 * Seeds an inviting org (owner = inviter, who holds their own default key
 * there — the per-user mint must not be satisfied by a teammate's key) plus an
 * invitee who already owns a solo org with the default key signup gave them,
 * and a pending invite addressed to the invitee's email.
 */
async function seedInviteScenario(): Promise<SeedResult> {
  const inviterOrgId = uid();
  const inviterUserId = uid();
  const inviteeOrgId = uid();
  const inviteeUserId = uid();
  const inviteeEmail = `invitee-${inviteeUserId}@example.com`;
  const inviteeOldApiKey = `eliza_old_${inviteeUserId.replaceAll("-", "")}`;

  await dbWrite.insert(schemas.organizations).values([
    { id: inviterOrgId, name: "Team Org", slug: `team-${inviterOrgId}` },
    {
      id: inviteeOrgId,
      name: "Solo Org",
      slug: `solo-${inviteeOrgId}`,
      credit_balance: "5.000000",
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
  await dbWrite.insert(schemas.apiKeys).values([
    {
      id: uid(),
      name: "Default API Key",
      key_hash: `hash-inviter-${inviterUserId}`,
      key_prefix: "eliza_inv",
      organization_id: inviterOrgId,
      user_id: inviterUserId,
    },
    {
      id: uid(),
      name: "Default API Key",
      key_hash: hashApiKey(inviteeOldApiKey),
      key_prefix: "eliza_sol",
      organization_id: inviteeOrgId,
      user_id: inviteeUserId,
    },
  ]);

  const token = generateInviteToken();
  await dbWrite.insert(schemas.organizationInvites).values({
    id: uid(),
    organization_id: inviterOrgId,
    inviter_user_id: inviterUserId,
    invited_email: inviteeEmail,
    invited_role: "member",
    token_hash: hashInviteToken(token),
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
    status: "pending",
  });

  return {
    inviterOrgId,
    inviterUserId,
    inviteeOrgId,
    inviteeUserId,
    inviteeEmail,
    inviteeOldApiKey,
    token,
  };
}

async function readActiveKeys(
  userId: string,
  organizationId: string,
): Promise<Array<{ name: string; key_prefix: string }>> {
  const rows = await dbWrite.execute(
    `SELECT name, key_prefix FROM api_keys
     WHERE user_id = '${userId}' AND organization_id = '${organizationId}'
       AND is_active = true AND deleted_at IS NULL;`,
  );
  return rows.rows as Array<{ name: string; key_prefix: string }>;
}

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ apiKeysService } = await import("../api-keys"));
    ({ invitesService } = await import("../invites"));
    ({ syncUserFromSteward } = await import("../../steward-sync"));
    ({ generateInviteToken, hashInviteToken } = await import("../../utils/invite-tokens"));

    const { organizations } = await import("../../../db/schemas/organizations");
    const { users } = await import("../../../db/schemas/users");
    const { userIdentities } = await import("../../../db/schemas/user-identities");
    const { organizationInvites } = await import("../../../db/schemas/organization-invites");
    const { apiKeys } = await import("../../../db/schemas/api-keys");
    const { creditTransactions } = await import("../../../db/schemas/credit-transactions");
    const { userCharacters } = await import("../../../db/schemas/user-characters");
    const { conversations } = await import("../../../db/schemas/conversations");
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
    schemas = { organizations, users, organizationInvites, apiKeys };

    const { pushSchema } = await import("../../../db/push-schema-for-tests");
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        userIdentities,
        organizationInvites,
        apiKeys,
        creditTransactions,
        userCharacters,
        conversations,
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
    console.error(
      "[invite-accept-default-key.test] PGlite/pushSchema unavailable — failing.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("invite accept provisions the personal default API key", () => {
  test(
    "existing owner accepting an invite holds an active personal default key in the inviting org",
    async () => {
      expect(pgliteReady).toBe(true);
      const seeded = await seedInviteScenario();

      await invitesService.acceptInvite(seeded.token, seeded.inviteeUserId);

      // The vacated solo org is deleted and its cascade destroyed the old
      // default key — the accept must have minted a fresh personal key in the
      // inviting org or the user is left unable to use inference at all.
      const keys = await readActiveKeys(seeded.inviteeUserId, seeded.inviterOrgId);
      expect(keys.length).toBe(1);
      expect(keys[0].name).toBe("Default API Key");
      expect(keys[0].key_prefix.length).toBeGreaterThan(0);

      const anywhere = await dbWrite.execute(
        `SELECT id FROM api_keys WHERE user_id = '${seeded.inviteeUserId}' AND organization_id = '${seeded.inviteeOrgId}';`,
      );
      expect(anywhere.rows.length).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "non-owner member accepting an invite gets a personal default key in the inviting org",
    async () => {
      expect(pgliteReady).toBe(true);
      const seeded = await seedInviteScenario();
      // Reshape: the invitee is a plain member of an org that keeps its owner,
      // so the org they leave (and their old key in it) survives the move.
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

      await invitesService.acceptInvite(seeded.token, seeded.inviteeUserId);

      // The old org survives, but the user's old keys authenticate as that
      // tenant and must be revoked when the user moves.
      const oldOrgKeys = await readActiveKeys(seeded.inviteeUserId, seeded.inviteeOrgId);
      expect(oldOrgKeys.length).toBe(0);
      await expect(apiKeysService.validateApiKey(seeded.inviteeOldApiKey)).resolves.toBeNull();

      // The new org must hold its own personal default key for this user.
      const keys = await readActiveKeys(seeded.inviteeUserId, seeded.inviterOrgId);
      expect(keys.length).toBe(1);
      expect(keys[0].name).toBe("Default API Key");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "stale user-owned target-org keys do not satisfy the personal default-key guarantee",
    async () => {
      expect(pgliteReady).toBe(true);
      const seeded = await seedInviteScenario();
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
      await dbWrite.insert(schemas.apiKeys).values({
        id: uid(),
        name: "Default API Key",
        key_hash: `hash-stale-${seeded.inviteeUserId}`,
        key_prefix: "eliza_old",
        organization_id: seeded.inviterOrgId,
        user_id: seeded.inviteeUserId,
        is_active: true,
        expires_at: new Date(Date.now() - 60_000),
        deleted_at: new Date(Date.now() - 30_000),
      });

      await invitesService.acceptInvite(seeded.token, seeded.inviteeUserId);

      const keys = await readActiveKeys(seeded.inviteeUserId, seeded.inviterOrgId);
      expect(keys.length).toBe(1);
      expect(keys[0].name).toBe("Default API Key");
      expect(keys[0].key_prefix).not.toBe("eliza_old");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "invite accept rejects when the required default-key mint fails",
    async () => {
      expect(pgliteReady).toBe(true);
      const seeded = await seedInviteScenario();
      const originalProvision = apiKeysService.provisionDefaultApiKey;
      apiKeysService.provisionDefaultApiKey = mock(async () => {
        throw new Error("kms unavailable");
      }) as typeof apiKeysService.provisionDefaultApiKey;

      try {
        await expect(
          invitesService.acceptInvite(seeded.token, seeded.inviteeUserId),
        ).rejects.toThrow("kms unavailable");
      } finally {
        apiKeysService.provisionDefaultApiKey = originalProvision;
      }
    },
    PGLITE_TIMEOUT,
  );

  test(
    "concurrent default-key provisioning mints one active default key",
    async () => {
      expect(pgliteReady).toBe(true);
      const organizationId = uid();
      const userId = uid();

      await dbWrite.insert(schemas.organizations).values({
        id: organizationId,
        name: "Team Org",
        slug: `team-${organizationId}`,
      });
      await dbWrite.insert(schemas.users).values({
        id: userId,
        steward_user_id: `steward-${userId}`,
        email: `user-${userId}@example.com`,
        organization_id: organizationId,
        role: "member",
      });

      await Promise.all([
        apiKeysService.provisionDefaultApiKey(userId, organizationId),
        apiKeysService.provisionDefaultApiKey(userId, organizationId),
      ]);

      const keys = await readActiveKeys(userId, organizationId);
      expect(keys.length).toBe(1);
      expect(keys[0].name).toBe("Default API Key");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "brand-new invited signup (steward-sync pending-invite branch) has the default key when sync resolves",
    async () => {
      expect(pgliteReady).toBe(true);
      const inviterOrgId = uid();
      const inviterUserId = uid();
      const newcomerEmail = `newcomer-${inviterOrgId}@example.com`;

      await dbWrite.insert(schemas.organizations).values({
        id: inviterOrgId,
        name: "Team Org",
        slug: `team-${inviterOrgId}`,
      });
      await dbWrite.insert(schemas.users).values({
        id: inviterUserId,
        steward_user_id: `steward-${inviterUserId}`,
        email: `inviter-${inviterUserId}@example.com`,
        organization_id: inviterOrgId,
        role: "owner",
      });
      await dbWrite.insert(schemas.apiKeys).values({
        id: uid(),
        name: "Default API Key",
        key_hash: `hash-inviter-${inviterUserId}`,
        key_prefix: "eliza_inv",
        organization_id: inviterOrgId,
        user_id: inviterUserId,
      });
      await dbWrite.insert(schemas.organizationInvites).values({
        id: uid(),
        organization_id: inviterOrgId,
        inviter_user_id: inviterUserId,
        invited_email: newcomerEmail,
        invited_role: "member",
        token_hash: hashInviteToken(generateInviteToken()),
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
        status: "pending",
      });

      const synced = await syncUserFromSteward({
        stewardUserId: `steward-newcomer-${inviterOrgId}`,
        email: newcomerEmail,
      });

      expect(synced.organization_id).toBe(inviterOrgId);
      expect(synced.role).toBe("member");

      // Same guarantee as a direct signup: the personal default key exists by
      // the time the sync resolves (awaited — on Cloudflare Workers a floating
      // mint is cancelled when the response returns, see #11270).
      const keys = await readActiveKeys(synced.id, inviterOrgId);
      expect(keys.length).toBe(1);
      expect(keys[0].name).toBe("Default API Key");
      expect(keys[0].key_prefix.length).toBeGreaterThan(0);
    },
    PGLITE_TIMEOUT,
  );
});
