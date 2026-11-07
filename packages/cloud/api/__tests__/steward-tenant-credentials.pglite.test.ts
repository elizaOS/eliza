/**
 * The organization's Steward tenant key is full authority over every wallet in
 * the tenant. Only an owner or admin, with their own owner credential, may read
 * it from GET /api/v1/steward/tenants/credentials.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";

const ORG = "11111111-1111-4111-8111-111111111111";
const TENANT_KEY = "stw_tenant_full_authority_canary";

let role = "member";
let ownerCredential = true;

const realAuth = { ...(await import("@elizaos/cloud-shared/auth")) };
const { ForbiddenError } = await import(
  "@elizaos/cloud-shared/lib/api/cloud-worker-errors"
);
mock.module("@elizaos/cloud-shared/auth", () => ({
  ...realAuth,
  requireUserOrApiKeyWithOrg: async () => ({
    id: "33333333-3333-4333-8333-333333333333",
    organization_id: ORG,
    role,
    organization: { id: ORG, name: "Shared org", is_active: true },
    is_active: true,
  }),
  // The owner-credential admission has its own tests; here it stands for a
  // session (allowed) or an app-scoped key (refused).
  requirePrivateOwnerAccess: async () => {
    if (!ownerCredential)
      throw ForbiddenError("This credential cannot access private owner data");
  },
}));

const { dbWrite, closeDatabaseConnectionsForTests } = await import(
  "@elizaos/cloud-shared/db/client"
);
const { organizations } = await import(
  "@elizaos/cloud-shared/db/schemas/organizations"
);
const { Hono } = await import("hono");
const { default: route } = await import(
  "../v1/steward/tenants/credentials/route"
);

const app = new Hono().route("/api/v1/steward/tenants/credentials", route);

async function readCredentials(): Promise<{ status: number; text: string }> {
  const response = await app.request(
    "/api/v1/steward/tenants/credentials",
    {},
    { STEWARD_API_URL: "https://steward.example.test" },
  );
  return { status: response.status, text: await response.text() };
}

beforeAll(async () => {
  const { apply } = await pushSchema(
    { organizations } as never,
    dbWrite as never,
  );
  await apply();
  await dbWrite.insert(organizations).values({
    id: ORG,
    name: "Shared org",
    slug: "shared-org",
    steward_tenant_id: "elizacloud-shared-org",
    steward_tenant_api_key: TENANT_KEY,
  } as never);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
  mock.restore();
});

test("a plain member does not receive the tenant key", async () => {
  role = "member";
  ownerCredential = true;
  const { status, text } = await readCredentials();
  expect(status).toBe(403);
  expect(text).not.toContain(TENANT_KEY);
});

test("an owner using an app-scoped key does not receive the tenant key", async () => {
  role = "owner";
  ownerCredential = false;
  const { status, text } = await readCredentials();
  expect(status).toBe(403);
  expect(text).not.toContain(TENANT_KEY);
});

test("an owner with their own credential receives the tenant key", async () => {
  role = "owner";
  ownerCredential = true;
  const { status, text } = await readCredentials();
  expect(status).toBe(200);
  expect(JSON.parse(text).apiKey).toBe(TENANT_KEY);
});
