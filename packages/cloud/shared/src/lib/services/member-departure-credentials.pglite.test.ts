/**
 * Credentials a member brought into an organization leave with the member:
 * their contributed provider key leaves the team pool, a connection they
 * linked themselves is revoked, and an org agent bound to their Discord guild
 * is unbound. Other members' credentials stay. Both ways out of an
 * organization run: removal (detachFromOrganization) and accepting another
 * organization's invite.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";

const ORG = "11111111-1111-4111-8111-111111111111";
const STAYING = "22222222-2222-4222-8222-222222222222";
const LEAVING = "33333333-3333-4333-8333-333333333333";
const JOINING = "44444444-4444-4444-8444-444444444444";
const OTHER_ORG = "55555555-5555-4555-8555-555555555555";

const { dbWrite, closeDatabaseConnectionsForTests } = await import("../../db/client");
const { organizations } = await import("../../db/schemas/organizations");
const { users } = await import("../../db/schemas/users");
const schemaSecrets = await import("../../db/schemas/secrets");
const { pooledCredentials, pooledCredentialUsage } = await import(
  "../../db/schemas/pooled-credentials"
);
const platformSchema = await import("../../db/schemas/platform-credentials");
const appsSchema = await import("../../db/schemas/apps");
const { agentSandboxes } = await import("../../db/schemas/agent-sandboxes");
const { userCharacters } = await import("../../db/schemas/user-characters");
const { apiKeys } = await import("../../db/schemas/api-keys");
const { userIdentities } = await import("../../db/schemas/user-identities");
const personalSharedGroups = await import("../../db/schemas/personal-shared-groups");
const { organizationInvites } = await import("../../db/schemas/organization-invites");
const { hashInviteToken } = await import("../utils/invite-tokens");
const { readManagedAgentDiscordBinding } = await import("./eliza-agent-config");
const { pooledCredentialsRepository } = await import("../../db/repositories/pooled-credentials");
const { usersService } = await import("./users");
const { invitesService } = await import("./invites");

beforeAll(async () => {
  const { apply } = await pushSchema(
    {
      organizations,
      users,
      ...schemaSecrets,
      pooledCredentials,
      pooledCredentialUsage,
      ...platformSchema,
      ...appsSchema,
      userCharacters,
      agentSandboxes,
      apiKeys,
      userIdentities,
      ...personalSharedGroups,
      organizationInvites,
    } as never,
    dbWrite as never,
  );
  await apply();
  await dbWrite.insert(organizations).values([
    { id: ORG, name: "Team", slug: "team" },
    { id: OTHER_ORG, name: "Other team", slug: "other-team" },
  ] as never);
  for (const [id, email] of [
    [STAYING, "staying@example.test"],
    [LEAVING, "leaving@example.test"],
    [JOINING, "joining@example.test"],
  ])
    await dbWrite
      .insert(users)
      .values({ id, email, organization_id: ORG, steward_user_id: `steward-${id}` } as never);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
});

async function seedSecret(createdBy: string): Promise<string> {
  const [row] = await dbWrite
    .insert(schemaSecrets.secrets)
    .values({
      organization_id: ORG,
      name: `KEY_${crypto.randomUUID()}`,
      encrypted_value: "ciphertext",
      encryption_key_id: "kek",
      encrypted_dek: "dek",
      nonce: "nonce",
      auth_tag: "tag",
      created_by: createdBy,
    } as never)
    .returning();
  return (row as { id: string }).id;
}

async function seedLinkedIn(userId: string): Promise<string> {
  const [row] = await dbWrite
    .insert(platformSchema.platformCredentials)
    .values({
      organization_id: ORG,
      user_id: userId,
      platform: "linkedin",
      platform_user_id: `urn:li:person:${crypto.randomUUID()}`,
      status: "active",
    } as never)
    .returning();
  return (row as { id: string }).id;
}

async function seedDiscordBoundAgent(adminElizaUserId: string): Promise<string> {
  const [row] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: ORG,
      user_id: STAYING,
      status: "stopped",
      agent_config: {
        __agentManagedDiscord: {
          mode: "cloud-managed",
          guildId: `guild-${adminElizaUserId}`,
          guildName: "Guild",
          adminDiscordUserId: `discord-${adminElizaUserId}`,
          adminDiscordUsername: "admin",
          adminElizaUserId,
          connectedAt: "2026-11-01T00:00:00.000Z",
        },
      },
    } as never)
    .returning();
  return (row as { id: string }).id;
}

async function seedMemberCredentials(userId: string) {
  const [contributed] = await dbWrite
    .insert(pooledCredentials)
    .values({
      organization_id: ORG,
      provider: "openai-api",
      secret_id: await seedSecret(userId),
      label: "Departing member's OpenAI key",
      key_last4: "abcd",
      contributed_by: userId,
    } as never)
    .returning();
  return {
    pooledId: (contributed as { id: string }).id,
    linkedId: await seedLinkedIn(userId),
    guildAgentId: await seedDiscordBoundAgent(userId),
  };
}

async function seedStayingCredentials() {
  const [contributed] = await dbWrite
    .insert(pooledCredentials)
    .values({
      organization_id: ORG,
      provider: "anthropic-api",
      secret_id: await seedSecret(STAYING),
      label: "Staying member's key",
      key_last4: "wxyz",
      contributed_by: STAYING,
    } as never)
    .returning();
  return {
    pooledId: (contributed as { id: string }).id,
    guildAgentId: await seedDiscordBoundAgent(STAYING),
  };
}

async function bindingOf(agentId: string) {
  const [agent] = await dbWrite
    .select({ agent_config: agentSandboxes.agent_config })
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, agentId));
  return readManagedAgentDiscordBinding(agent?.agent_config as Record<string, unknown> | null);
}

async function expectReleased(
  departed: Awaited<ReturnType<typeof seedMemberCredentials>>,
  staying: Awaited<ReturnType<typeof seedStayingCredentials>>,
) {
  const remaining = (await pooledCredentialsRepository.listByOrganization(ORG)).map(
    (row) => row.id,
  );
  expect(remaining).not.toContain(departed.pooledId);
  expect(remaining).toContain(staying.pooledId);
  const [connection] = await dbWrite
    .select({ status: platformSchema.platformCredentials.status })
    .from(platformSchema.platformCredentials)
    .where(eq(platformSchema.platformCredentials.id, departed.linkedId));
  expect(connection?.status).toBe("revoked");
  // The org agent bound to the departing member's guild is unbound; the one
  // the staying member bound is kept.
  expect(await bindingOf(departed.guildAgentId)).toBeNull();
  expect((await bindingOf(staying.guildAgentId))?.adminElizaUserId).toBe(STAYING);
}

test("a removed member's contributed key, linked connection and guild binding leave with them", async () => {
  const departed = await seedMemberCredentials(LEAVING);
  const staying = await seedStayingCredentials();

  const moved = await usersService.detachFromOrganization(LEAVING);
  expect(moved.organization_id).not.toBe(ORG);

  await expectReleased(departed, staying);
});

test("a member who accepts another organization's invite takes their credentials along", async () => {
  const departed = await seedMemberCredentials(JOINING);
  const staying = await seedStayingCredentials();
  const token = "invite-token-joining";
  await dbWrite.insert(organizationInvites).values({
    organization_id: OTHER_ORG,
    inviter_user_id: STAYING,
    invited_email: "joining@example.test",
    invited_role: "member",
    token_hash: hashInviteToken(token),
    expires_at: new Date(Date.now() + 60_000),
    status: "pending",
  } as never);

  await invitesService.acceptInvite(token, JOINING);

  await expectReleased(departed, staying);
});
