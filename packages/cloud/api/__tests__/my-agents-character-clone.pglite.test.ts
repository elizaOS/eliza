/**
 * "Duplicate agent" copies the whole character: its message and post examples,
 * and, for the owner's own clone, its secrets. Real clone and character
 * routes, metered character create and PGlite; only auth is stubbed.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const USER_X = "44444444-4444-4444-8444-444444444444";
const CHAR = "55555555-5555-4555-8555-555555555555";
const current = {
  id: USER_X,
  organization_id: ORG_A,
  organization: { id: ORG_A, name: "org", is_active: true },
  is_active: true,
  role: "owner",
};
const realAuth = { ...(await import("@elizaos/cloud-shared/auth")) };
mock.module("@elizaos/cloud-shared/auth", () => ({
  ...realAuth,
  requireUserOrApiKeyWithOrg: async () => current,
}));

const { dbWrite, closeDatabaseConnectionsForTests } = await import(
  "@elizaos/cloud-shared/db/client"
);
const schemas = {
  organizations: (
    await import("@elizaos/cloud-shared/db/schemas/organizations")
  ).organizations,
  users: (await import("@elizaos/cloud-shared/db/schemas/users")).users,
};
const { userCharacters } = await import(
  "@elizaos/cloud-shared/db/schemas/user-characters"
);
const { eq } = await import("drizzle-orm");
const { Hono } = await import("hono");
const { default: cloneRoute } = await import(
  "../my-agents/characters/[id]/clone/route"
);
const { default: getRoute } = await import(
  "../my-agents/characters/[id]/route"
);

const app = new Hono()
  .route("/api/my-agents/characters/:id/clone", cloneRoute)
  .route("/api/my-agents/characters/:id", getRoute);
const env = { NODE_ENV: "test", RATE_LIMIT_DISABLED: "true" };

beforeAll(async () => {
  const base = "../../shared/src/db/schemas/";
  const { orgRateLimitOverrides } = await import(
    `${base}org-rate-limit-overrides.ts`
  );
  const { organizationConfig } = await import(`${base}organization-config.ts`);
  const { orgStorageQuota } = await import(`${base}org-storage-quota.ts`);
  const { creditTransactions } = await import(`${base}credit-transactions.ts`);
  const { billingSubscriptions, organizationSubscriptionAuthorities } =
    await import(`${base}billing-subscriptions.ts`);
  const { organizationEntitlements } = await import(
    `${base}organization-entitlements.ts`
  );
  const { getTableConfig } = await import("drizzle-orm/pg-core");
  const { sql } = await import("drizzle-orm");
  const { agentTable } = (await import("@elizaos/plugin-sql")) as unknown as {
    agentTable: unknown;
  };
  const { apply } = await pushSchema(
    {
      organizations: schemas.organizations,
      users: schemas.users,
      userCharacters,
      creditTransactions,
      agentTable,
    } as never,
    dbWrite as never,
  );
  await apply();
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
      `INSERT INTO organization_subscription_authorities (organization_id, state, policy_generation) VALUES ('${ORG_A}', 'none', 1)`,
    ),
  );
  await dbWrite.insert(schemas.organizations).values({
    id: ORG_A,
    name: "Org A",
    slug: "org-a",
    credit_balance: "100.00",
  });
  await dbWrite.insert(schemas.users).values({
    id: USER_X,
    organization_id: ORG_A,
    steward_user_id: "s-x",
    email: "x@example.test",
  });
  await dbWrite.insert(userCharacters).values({
    id: CHAR,
    organization_id: ORG_A,
    user_id: USER_X,
    name: "Support",
    username: "support-orig",
    bio: ["helps"],
    system: "sys",
    message_examples: [
      [
        { name: "user", content: { text: "hi" } },
        { name: "Support", content: { text: "hello!" } },
      ],
    ],
    post_examples: ["post one"],
    secrets: { OPENAI_API_KEY: "sk-owner" },
    settings: {},
    character_data: {},
  });
}, 180_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
  mock.restore();
});

test("an owner's duplicate keeps its message examples, post examples and secrets", async () => {
  const response = await app.request(
    `/api/my-agents/characters/${CHAR}/clone`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Support (Copy)" }),
    },
    env,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: { character: { id: string } };
  };
  const cloneId = body.data.character.id;
  const [original] = await dbWrite
    .select()
    .from(userCharacters)
    .where(eq(userCharacters.id, CHAR));
  const [copy] = await dbWrite
    .select()
    .from(userCharacters)
    .where(eq(userCharacters.id, cloneId));
  expect(copy?.message_examples).toEqual(original?.message_examples);
  expect(copy?.post_examples).toEqual(original?.post_examples);
  expect(copy?.secrets).toEqual({ OPENAI_API_KEY: "sk-owner" });

  // The copy's examples reach the character the runtime reads.
  const read = (await (
    await app.request(`/api/my-agents/characters/${cloneId}`, {}, env)
  ).json()) as {
    data: { character: { messageExamples: unknown; postExamples: unknown } };
  };
  expect(read.data.character.postExamples).toEqual(["post one"]);
});
