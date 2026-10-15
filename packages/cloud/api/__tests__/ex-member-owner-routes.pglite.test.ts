/**
 * A member removed from an organization keeps their user id and moves to a
 * new personal organization. Routes that act on the old organization's agents,
 * characters and media must not accept the creator match alone.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "33333333-3333-4333-8333-333333333333";
const USER_X = "44444444-4444-4444-8444-444444444444";
const CHAR = "55555555-5555-4555-8555-555555555555";
const PUB = "66666666-6666-4666-8666-666666666666";
const GEN = "77777777-7777-4777-8777-777777777777";

function caller(organizationId: string) {
  return {
    id: USER_X,
    organization_id: organizationId,
    organization: { id: organizationId, name: "org", is_active: true },
    is_active: true,
    role: "owner",
  };
}
// X created the rows below in ORG_A and was then removed (now in ORG_B).
const current = caller(ORG_B);

const realAuth = { ...(await import("@elizaos/cloud-shared/auth")) };
mock.module("@elizaos/cloud-shared/auth", () => ({
  ...realAuth,
  requireUserOrApiKeyWithOrg: async () => current,
  requireUserOrApiKey: async () => current,
}));
const realRateLimit = {
  ...(await import(
    "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare"
  )),
};
mock.module(
  "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare",
  () => ({
    ...realRateLimit,
    rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  }),
);

const { dbWrite, closeDatabaseConnectionsForTests } = await import(
  "@elizaos/cloud-shared/db/client"
);
const schema = await import("@elizaos/cloud-shared/db/schemas");
const { eq } = await import("drizzle-orm");
const { Hono } = await import("hono");
const { default: cloneRoute } = await import(
  "../my-agents/characters/[id]/clone/route"
);
const { default: publishRoute } = await import(
  "../v1/agents/[agentId]/publish/route"
);
const { default: monetRoute } = await import(
  "../v1/agents/[agentId]/monetization/route"
);
const { default: galleryRoute } = await import("../v1/gallery/[id]/route");

const app = new Hono()
  .route("/api/my-agents/characters/:id/clone", cloneRoute)
  .route("/api/v1/agents/:agentId/publish", publishRoute)
  .route("/api/v1/agents/:agentId/monetization", monetRoute)
  .route("/api/v1/gallery/:id", galleryRoute);
const env = { NODE_ENV: "test", RATE_LIMIT_DISABLED: "true" };
const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  const {
    organizations,
    users,
    userCharacters,
    generations,
    apiKeys,
    usageRecords,
    creditTransactions,
    agentTable,
    authEvents,
  } = schema;
  const { apply } = await pushSchema(
    {
      organizations,
      users,
      userCharacters,
      generations,
      apiKeys,
      usageRecords,
      creditTransactions,
      agentTable,
      authEvents,
    } as never,
    dbWrite as never,
  );
  await apply();
  const base = "../../shared/src/db/schemas/";
  const { orgRateLimitOverrides } = await import(
    `${base}org-rate-limit-overrides.ts`
  );
  const { organizationConfig } = await import(`${base}organization-config.ts`);
  const { orgStorageQuota } = await import(`${base}org-storage-quota.ts`);
  const { billingSubscriptions, organizationSubscriptionAuthorities } =
    await import(`${base}billing-subscriptions.ts`);
  const { organizationEntitlements } = await import(
    `${base}organization-entitlements.ts`
  );
  const { getTableConfig } = await import("drizzle-orm/pg-core");
  const { sql } = await import("drizzle-orm");
  for (const [name, table] of [
    ["billing_subscriptions", billingSubscriptions],
    [
      "organization_subscription_authorities",
      organizationSubscriptionAuthorities,
    ],
    ["org_rate_limit_overrides", orgRateLimitOverrides],
    ["organization_config", organizationConfig],
    ["org_storage_quota", orgStorageQuota],
    ["organization_entitlements", organizationEntitlements],
  ] as const) {
    await dbWrite.execute(
      sql.raw(
        `CREATE TABLE ${name} (${getTableConfig(table as never)
          .columns.map((c) => `"${c.name}" ${c.getSQLType()}`)
          .join(",")})`,
      ),
    );
  }
  await dbWrite.execute(
    sql.raw(
      `INSERT INTO organization_subscription_authorities (organization_id, state, policy_generation) VALUES ('${ORG_A}', 'none', 1), ('${ORG_B}', 'none', 1)`,
    ),
  );
  await dbWrite.insert(organizations).values([
    { id: ORG_A, name: "Org A", slug: "org-a", credit_balance: "100.00" },
    {
      id: ORG_B,
      name: "X personal",
      slug: "x-personal",
      credit_balance: "100.00",
    },
  ]);
  await dbWrite.insert(users).values({
    id: USER_X,
    organization_id: ORG_B,
    steward_user_id: "s-x",
    email: "x@example.test",
  });
  // What PUT /api/my-agents/characters/:id stores: every field, secrets included, in character_data.
  await dbWrite.insert(userCharacters).values([
    {
      id: CHAR,
      organization_id: ORG_A,
      user_id: USER_X,
      name: "Org A private agent",
      bio: ["org A"],
      system: "org A private system prompt",
      is_public: false,
      secrets: { OPENAI_API_KEY: "sk-org-a-secret" },
      settings: { secrets: { DISCORD_TOKEN: "org-a-discord" } },
      character_data: { secrets: { OPENAI_API_KEY: "sk-org-a-secret" } },
    },
    {
      id: PUB,
      organization_id: ORG_A,
      user_id: USER_X,
      name: "Org A public agent",
      bio: ["org A"],
      is_public: true,
      settings: {},
      character_data: {},
    },
  ]);
  await dbWrite.insert(generations).values({
    id: GEN,
    organization_id: ORG_A,
    user_id: USER_X,
    type: "image",
    model: "m",
    provider: "p",
    prompt: "org A asset",
    status: "completed",
  } as never);
}, 180_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
  mock.restore();
});

test("an ex-member cannot clone the old organization's private character", async () => {
  const response = await app.request(
    `/api/my-agents/characters/${CHAR}/clone`,
    json("POST", {}),
    env,
  );
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("sk-org-a-secret");
});

test("an ex-member cannot read or change the old organization's agent monetization", async () => {
  const put = await app.request(
    `/api/v1/agents/${PUB}/monetization`,
    json("PUT", { payoutWalletAddress: "0xattacker" }),
    env,
  );
  expect(put.status).not.toBe(200);
  const [row] = await dbWrite
    .select()
    .from(schema.userCharacters)
    .where(eq(schema.userCharacters.id, PUB));
  expect(row?.payout_wallet_address).not.toBe("0xattacker");

  const get = await app.request(`/api/v1/agents/${PUB}/monetization`, {}, env);
  expect(get.status).toBe(403);
});

test("an ex-member cannot unpublish the old organization's agent", async () => {
  const response = await app.request(
    `/api/v1/agents/${PUB}/publish`,
    { method: "DELETE" },
    env,
  );
  expect(response.status).toBe(403);
  const [row] = await dbWrite
    .select()
    .from(schema.userCharacters)
    .where(eq(schema.userCharacters.id, PUB));
  expect(row?.is_public).toBe(true);
});

test("an ex-member cannot delete the old organization's gallery media", async () => {
  const response = await app.request(
    `/api/v1/gallery/${GEN}`,
    { method: "DELETE" },
    env,
  );
  expect(response.status).toBe(404);
  const [row] = await dbWrite
    .select()
    .from(schema.generations)
    .where(eq(schema.generations.id, GEN));
  expect(row?.status).toBe("completed");
});
