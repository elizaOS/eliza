/**
 * GET /api/v1/agents/:agentId returns the full character row, secrets
 * included. Characters belong to their creator inside an organization, so
 * another member of the same organization (or an API key of that member)
 * must get 404, while the creator still reads the agent.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

const ORG = "11111111-1111-4111-8111-1111111111f1";
const CREATOR = "44444444-4444-4444-8444-4444444444f1";
const MEMBER = "44444444-4444-4444-8444-4444444444f2";
const CHAR = "55555555-5555-4555-8555-5555555555f1";

let current = CREATOR;
const realAuth = { ...(await import("@elizaos/cloud-shared/auth")) };
mock.module("@elizaos/cloud-shared/auth", () => ({
  ...realAuth,
  requireUserOrApiKeyWithOrg: async () => ({
    id: current,
    organization_id: ORG,
    organization: { id: ORG, name: "Org", is_active: true },
    is_active: true,
    role: current === CREATOR ? "owner" : "member",
  }),
}));

const { dbWrite, closeDatabaseConnectionsForTests } = await import(
  "@elizaos/cloud-shared/db/client"
);
const schema = await import("@elizaos/cloud-shared/db/schemas");
const { Hono } = await import("hono");
const { default: agentRoute } = await import("../v1/agents/[agentId]/route");

const app = new Hono().route("/api/v1/agents/:agentId", agentRoute);
const env = { NODE_ENV: "test", RATE_LIMIT_DISABLED: "true" };

beforeAll(async () => {
  const { organizations, users, userCharacters, authEvents } = schema;
  const { apply } = await pushSchema(
    { organizations, users, userCharacters, authEvents } as never,
    dbWrite as never,
  );
  await apply();
  await dbWrite
    .insert(organizations)
    .values({ id: ORG, name: "Org", slug: "org-agent-detail" });
  await dbWrite.insert(users).values([
    {
      id: CREATOR,
      organization_id: ORG,
      steward_user_id: "s-creator",
      email: "creator@example.test",
    },
    {
      id: MEMBER,
      organization_id: ORG,
      steward_user_id: "s-member",
      email: "member@example.test",
    },
  ]);
  await dbWrite.insert(userCharacters).values({
    id: CHAR,
    organization_id: ORG,
    user_id: CREATOR,
    name: "Creator's agent",
    bio: ["private"],
    is_public: false,
    secrets: { OPENAI_API_KEY: "sk-creator-secret" },
    settings: {},
    character_data: {},
  });
}, 180_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
  mock.restore();
});

async function getAgent(userId: string) {
  current = userId;
  const response = await app.request(`/api/v1/agents/${CHAR}`, {}, env);
  return { status: response.status, body: await response.text() };
}

test("another member of the organization cannot read the agent or its secrets", async () => {
  const response = await getAgent(MEMBER);
  expect(response.status).toBe(404);
  expect(response.body).not.toContain("sk-creator-secret");
});

test("the creator still reads the agent", async () => {
  const response = await getAgent(CREATOR);
  expect(response.status).toBe(200);
  expect(response.body).toContain("Creator's agent");
});
