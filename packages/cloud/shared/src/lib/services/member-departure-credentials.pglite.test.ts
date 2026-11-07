/**
 * Credentials a member brought into an organization leave with the member:
 * their contributed provider key leaves the team pool, and a connection they
 * linked themselves is revoked. Other members' credentials stay.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";

const ORG = "11111111-1111-4111-8111-111111111111";
const STAYING = "22222222-2222-4222-8222-222222222222";
const LEAVING = "33333333-3333-4333-8333-333333333333";

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
const { readManagedAgentDiscordBinding } = await import("./eliza-agent-config");
const { pooledCredentialsRepository } = await import("../../db/repositories/pooled-credentials");
const { releaseDepartedMemberCredentials } = await import("./member-departure-credentials");

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
    } as never,
    dbWrite as never,
  );
  await apply();
  await dbWrite.insert(organizations).values({ id: ORG, name: "Team", slug: "team" } as never);
  for (const [id, email] of [
    [STAYING, "staying@example.test"],
    [LEAVING, "leaving@example.test"],
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

test("a departing member's contributed key and linked connection leave with them", async () => {
  const theirs = await dbWrite
    .insert(pooledCredentials)
    .values({
      organization_id: ORG,
      provider: "openai-api",
      secret_id: await seedSecret(LEAVING),
      label: "Leaving member's OpenAI key",
      key_last4: "abcd",
      contributed_by: LEAVING,
    } as never)
    .returning();
  const teams = await dbWrite
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
  const linked = await seedLinkedIn(LEAVING);
  const leavingGuildAgent = await seedDiscordBoundAgent(LEAVING);
  const stayingGuildAgent = await seedDiscordBoundAgent(STAYING);

  // The step detachFromOrganization and the invite-accept leave path run.
  await releaseDepartedMemberCredentials(LEAVING, ORG);

  const remaining = (await pooledCredentialsRepository.listByOrganization(ORG)).map(
    (row) => row.id,
  );
  expect(remaining).not.toContain((theirs[0] as { id: string }).id);
  expect(remaining).toContain((teams[0] as { id: string }).id);
  const [connection] = await dbWrite
    .select({ status: platformSchema.platformCredentials.status })
    .from(platformSchema.platformCredentials)
    .where((await import("drizzle-orm")).eq(platformSchema.platformCredentials.id, linked));
  expect(connection?.status).toBe("revoked");
  const bindingOf = async (agentId: string) => {
    const [agent] = await dbWrite
      .select({ agent_config: agentSandboxes.agent_config })
      .from(agentSandboxes)
      .where((await import("drizzle-orm")).eq(agentSandboxes.id, agentId));
    return readManagedAgentDiscordBinding(agent?.agent_config as Record<string, unknown> | null);
  };
  // The org agent bound to the departing member's guild is unbound; the one
  // the staying member bound is kept.
  expect(await bindingOf(leavingGuildAgent)).toBeNull();
  expect((await bindingOf(stayingGuildAgent))?.adminElizaUserId).toBe(STAYING);
});
