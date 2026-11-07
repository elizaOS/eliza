/**
 * A member removed from an organization keeps their user id and moves to a
 * new personal organization. The characters they created stay in the old
 * organization, so the my-agents character routes must not hand them over on
 * the creator match alone.
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

function caller(organizationId: string) {
  return {
    id: USER_X,
    organization_id: organizationId,
    organization: { id: organizationId, name: "org", is_active: true },
    is_active: true,
    role: "owner",
  };
}
let current = caller(ORG_A);

const realAuth = { ...(await import("@elizaos/cloud-shared/auth")) };
mock.module("@elizaos/cloud-shared/auth", () => ({
  ...realAuth,
  requireUserOrApiKeyWithOrg: async () => current,
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
const { eq } = await import("drizzle-orm");
const { Hono } = await import("hono");
const { default: route } = await import("../my-agents/characters/[id]/route");

const app = new Hono().route("/api/my-agents/characters/:id", route);
const env = { NODE_ENV: "test", RATE_LIMIT_DISABLED: "true" };
const url = `/api/my-agents/characters/${CHAR}`;

beforeAll(async () => {
  const { apply } = await pushSchema(
    { organizations, users, userCharacters } as never,
    dbWrite as never,
  );
  await apply();
  await dbWrite.insert(organizations).values([
    { id: ORG_A, name: "Org A", slug: "org-a" },
    { id: ORG_B, name: "X personal", slug: "x-personal" },
  ]);
  await dbWrite.insert(users).values({
    id: USER_X,
    organization_id: ORG_A,
    steward_user_id: "s-x",
    email: "x@example.test",
  });
  await dbWrite.insert(userCharacters).values({
    id: CHAR,
    organization_id: ORG_A,
    user_id: USER_X,
    name: "Org A support agent",
    bio: ["org A"],
    system: "org A system prompt",
    secrets: { OPENAI_API_KEY: "sk-org-a-secret" },
    settings: {},
    character_data: {},
  });
}, 120_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
  mock.restore();
});

test("the creator reads their character while still in its organization", async () => {
  current = caller(ORG_A);
  const response = await app.request(url, {}, env);
  expect(response.status).toBe(200);
});

test("after removal the creator cannot read, rewrite or delete the old organization's character", async () => {
  current = caller(ORG_B);

  const get = await app.request(url, {}, env);
  expect(get.status).toBe(404);
  expect(await get.text()).not.toContain("sk-org-a-secret");

  const put = await app.request(
    url,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "hijacked",
        bio: ["x"],
        system: "attacker prompt",
      }),
    },
    env,
  );
  expect(put.status).toBe(404);

  const del = await app.request(url, { method: "DELETE" }, env);
  expect(del.status).toBe(404);

  const [row] = await dbWrite
    .select()
    .from(userCharacters)
    .where(eq(userCharacters.id, CHAR));
  expect(row?.system).toBe("org A system prompt");
});
