/**
 * POST /api/v1/apps/backup/restore applies the same rule to
 * `app.linked_character_ids` as PUT /apps/:id/characters: a character the
 * restoring user does not own and that is not public is dropped with a
 * warning, and GET /apps/:id/characters does not list it. Real routes,
 * PGlite database.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const USER_A = "22222222-2222-4222-8222-222222222222";
const ORG_B = "33333333-3333-4333-8333-333333333333";
const USER_B = "44444444-4444-4444-8444-444444444444";
const CHAR = "55555555-5555-4555-8555-555555555555";
const MISSING_CHAR = "77777777-7777-4777-8777-777777777777";

const userB = {
  id: USER_B,
  organization_id: ORG_B,
  organization: { id: ORG_B, name: "Org B", is_active: true },
  is_active: true,
  role: "owner",
};
const realLibAuth = { ...(await import("@elizaos/cloud-shared/lib/auth")) };
mock.module("@elizaos/cloud-shared/lib/auth", () => ({
  ...realLibAuth,
  requireAuthOrApiKeyWithOrg: async () => ({ user: userB, apiKey: undefined }),
}));
const realAuth = { ...(await import("@elizaos/cloud-shared/auth")) };
mock.module("@elizaos/cloud-shared/auth", () => ({
  ...realAuth,
  requireUserOrApiKeyWithOrg: async () => userB,
}));

const { dbWrite, closeDatabaseConnectionsForTests } = await import(
  "@elizaos/cloud-shared/db/client"
);
const { organizations } = await import(
  "@elizaos/cloud-shared/db/schemas/organizations"
);
const { users } = await import("@elizaos/cloud-shared/db/schemas/users");
const { userCharacters } = await import(
  "@elizaos/cloud-shared/db/schemas/user-characters"
);
const { apiKeys } = await import("@elizaos/cloud-shared/db/schemas/api-keys");
const { apps, appDeploymentStatusEnum, appReviewStatusEnum } = await import(
  "@elizaos/cloud-shared/db/schemas/apps"
);
const { charactersService } = await import(
  "@elizaos/cloud-shared/lib/services/characters"
);
const { appsService } = await import("@elizaos/cloud-shared/lib/services/apps");
const { Hono } = await import("hono");
const { default: appCharactersRoute } = await import(
  "../v1/apps/[id]/characters/route.ts"
);
const { default: restoreRoute } = await import(
  "../v1/apps/backup/restore/route.ts"
);

const app = new Hono();
app.route("/api/v1/apps/backup/restore", restoreRoute);
app.route("/api/v1/apps/:id/characters", appCharactersRoute);
const workerEnv = { NODE_ENV: "test", RATE_LIMIT_DISABLED: "true" };

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
  const schema = {
    organizations,
    users,
    userCharacters,
    apiKeys,
    appDeploymentStatusEnum,
    appReviewStatusEnum,
    apps,
    creditTransactions,
  };
  const { apply } = await pushSchema(schema as never, dbWrite as never);
  await apply();
  // Same pattern as billing-suspension-resume.pglite.test.ts: bare join tables
  // so the organization snapshot query used by app creation can run.
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
  await dbWrite.insert(organizations).values([
    { id: ORG_A, name: "Org A", slug: "org-a" },
    { id: ORG_B, name: "Org B", slug: "org-b" },
  ]);
  // Account authority rows so the organization policy snapshot resolves (state "none" = no subscription).
  await dbWrite.execute(
    sql.raw(
      `INSERT INTO organization_subscription_authorities (organization_id, state, policy_generation) VALUES ('${ORG_A}', 'none', 1), ('${ORG_B}', 'none', 1)`,
    ),
  );
  await dbWrite.insert(users).values([
    {
      id: USER_A,
      organization_id: ORG_A,
      steward_user_id: "steward-a",
      email: "a@example.test",
    },
    {
      id: USER_B,
      organization_id: ORG_B,
      steward_user_id: "steward-b",
      email: "b@example.test",
    },
  ]);
  // Never public: org A's private persona.
  await dbWrite.insert(userCharacters).values({
    id: CHAR,
    organization_id: ORG_A,
    user_id: USER_A,
    name: "Org A private persona",
    username: "org-a-persona",
    bio: ["internal persona of org A"],
    settings: { avatar: "https://cdn.example.test/org-a-avatar.png" },
    character_data: { name: "Org A private persona" },
    is_public: false,
  });
}, 300_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
  mock.restore();
});

test("restore drops a linked character the user may not link and never lists it", async () => {
  expect(
    await charactersService.getByIdForUser(CHAR, {
      id: USER_B,
      organization_id: ORG_B,
    }),
  ).toBeNull();

  const restore = await app.request(
    "/api/v1/apps/backup/restore",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        backup: {
          version: 1,
          app: {
            name: "Org B restored app",
            app_url: "https://app-b.example.test",
            linked_character_ids: [CHAR, MISSING_CHAR],
          },
          monetization: {
            enabled: false,
            inference_markup_percentage: 0,
            purchase_share_percentage: 0,
          },
        },
      }),
    },
    workerEnv,
  );
  const restored = (await restore.json()) as {
    success: boolean;
    app?: { id: string };
    warnings?: string[];
  };
  expect(restore.status).toBe(201);
  expect(restored.warnings).toEqual([
    `Linked character ${CHAR} was not restored: it is not yours and not public.`,
    `Linked character ${MISSING_CHAR} was not restored: it no longer exists.`,
  ]);
  const appId = restored.app!.id;
  expect((await appsService.getById(appId))?.linked_character_ids).toEqual([]);

  const read = await app.request(
    `/api/v1/apps/${appId}/characters`,
    { method: "GET" },
    workerEnv,
  );
  expect(read.status).toBe(200);
  expect((await read.json()) as unknown).toEqual({
    success: true,
    characters: [],
  });
});

test("a user who moved to another organization cannot restore or link their old organization's private character", async () => {
  // USER_B created this while in ORG_A, then moved to ORG_B (the caller's
  // current organization). The user id still matches; the organization does not.
  const OLD_CHAR = "77777777-7777-4777-8777-777777777777";
  await dbWrite.insert(userCharacters).values({
    id: OLD_CHAR,
    organization_id: ORG_A,
    user_id: USER_B,
    name: "Left behind in org A",
    username: "left-behind",
    bio: ["private to org A"],
    settings: {},
    character_data: { name: "Left behind in org A" },
    is_public: false,
  });

  const restore = await app.request(
    "/api/v1/apps/backup/restore",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        backup: {
          version: 1,
          app: {
            name: "Org B app with old character",
            app_url: "https://app-b2.example.test",
            linked_character_ids: [OLD_CHAR],
          },
          monetization: {
            enabled: false,
            inference_markup_percentage: 0,
            purchase_share_percentage: 0,
          },
        },
      }),
    },
    workerEnv,
  );
  const restored = (await restore.json()) as {
    app?: { id: string };
    warnings?: string[];
  };
  expect(restore.status).toBe(201);
  expect(restored.warnings).toEqual([
    `Linked character ${OLD_CHAR} was not restored: it is not yours and not public.`,
  ]);
  const appId = restored.app!.id;
  expect((await appsService.getById(appId))?.linked_character_ids).toEqual([]);

  const link = await app.request(
    `/api/v1/apps/${appId}/characters`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ character_ids: [OLD_CHAR] }),
    },
    workerEnv,
  );
  expect(link.status).toBe(403);
  expect((await appsService.getById(appId))?.linked_character_ids).toEqual([]);
});
