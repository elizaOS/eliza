/**
 * POST /api/v1/device-bus/devices upserts on a caller-chosen deviceId. A
 * device id that belongs to another user must not be updated. Real route,
 * PGlite database.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const USER_A = "22222222-2222-4222-8222-222222222222";
const ORG_B = "33333333-3333-4333-8333-333333333333";
const USER_B = "44444444-4444-4444-8444-444444444444";
const DEVICE_A = "55555555-5555-4555-8555-555555555555";

let caller = { id: USER_B, organization_id: ORG_B };
const realAuth = { ...(await import("@elizaos/cloud-shared/auth")) };
mock.module("@elizaos/cloud-shared/auth", () => ({
  ...realAuth,
  requireUserOrApiKeyWithOrg: async () => caller,
}));

const { dbWrite, closeDatabaseConnectionsForTests } = await import(
  "@elizaos/cloud-shared/db/client"
);
const { organizations } = await import(
  "@elizaos/cloud-shared/db/schemas/organizations"
);
const { users } = await import("@elizaos/cloud-shared/db/schemas/users");
const { devices } = await import("@elizaos/cloud-shared/db/schemas");
const { eq } = await import("drizzle-orm");
const { Hono } = await import("hono");
const { default: devicesRoute } = await import(
  "../v1/device-bus/devices/route.ts"
);

const app = new Hono();
app.route("/api/v1/device-bus/devices", devicesRoute);

beforeAll(async () => {
  const { apply } = await pushSchema(
    { organizations, users, devices } as never,
    dbWrite as never,
  );
  await apply();
  await dbWrite.insert(organizations).values([
    { id: ORG_A, name: "Org A", slug: "org-a" },
    { id: ORG_B, name: "Org B", slug: "org-b" },
  ]);
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
  await dbWrite.insert(devices).values({
    id: DEVICE_A,
    user_id: USER_A,
    platform: "ios",
    push_token: "token-a",
    label: "A's phone",
  });
}, 300_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
});

const register = (body: Record<string, unknown>) =>
  app.request("/api/v1/device-bus/devices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("another user cannot overwrite a registered device", async () => {
  caller = { id: USER_B, organization_id: ORG_B };
  const res = await register({
    deviceId: DEVICE_A,
    platform: "android",
    pushToken: "token-b",
    label: "B's label",
  });
  expect(res.status).toBe(409);
  expect(JSON.stringify(await res.json())).not.toContain(USER_A);
  const [row] = await dbWrite
    .select()
    .from(devices)
    .where(eq(devices.id, DEVICE_A));
  expect(row).toMatchObject({
    user_id: USER_A,
    platform: "ios",
    push_token: "token-a",
    label: "A's phone",
  });
});

test("the owner still updates their device", async () => {
  caller = { id: USER_A, organization_id: ORG_A };
  const res = await register({
    deviceId: DEVICE_A,
    platform: "ios",
    pushToken: "token-a2",
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    deviceId: DEVICE_A,
    userId: USER_A,
  });
  const [row] = await dbWrite
    .select()
    .from(devices)
    .where(eq(devices.id, DEVICE_A));
  expect(row?.push_token).toBe("token-a2");
});
