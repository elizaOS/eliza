/** Exercises pre-purchase product discovery with signed free-user sessions and real PostgreSQL ownership constraints. */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { ElizaCloudClient } from "@elizaos/cloud-sdk";
import { createPlaywrightTestSessionToken } from "@/lib/auth/playwright-test-session";
import {
  buyer,
  closeRecordsTest,
  db,
  env,
  merchant,
  org,
  postgresUrl,
  routes,
  setupRecordsTest,
} from "../../../apps/[id]/billing/records-test-harness";

setDefaultTimeout(120_000);
async function fixture() {
  const { identity } = await buyer();
  const slotKey = `product-${randomUUID()}`;
  const userId = randomUUID();
  await db.query(
    "INSERT INTO users(id,organization_id,email_verified,steward_user_id) VALUES($1::uuid,$2,true,$1::uuid::text)",
    [userId, org],
  );
  await db.query(
    "INSERT INTO app_billing_application_slots(slot_key,app_id,organization_id,merchant_id,livemode,product_family_key,manifest_digest) VALUES($1,$2,$3,$4,false,'main',$5)",
    [
      slotKey,
      identity.appId,
      org,
      merchant,
      randomUUID().replaceAll("-", "").repeat(2),
    ],
  );
  const token = createPlaywrightTestSessionToken(userId, org, env);
  const fetchImpl = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) =>
      routes.request(input, init, env),
    { preconnect: fetch.preconnect },
  );
  const client = new ElizaCloudClient({
    apiBaseUrl: "https://cloud.eliza.app/api/v1",
    fetchImpl,
    defaultHeaders: { cookie: `eliza-test-session=${token}` },
  });
  return { client, slotKey, identity, userId };
}

describe.skipIf(!postgresUrl)("native product billing discovery", () => {
  beforeAll(setupRecordsTest);
  afterAll(closeRecordsTest);
  test("a free identity resolves its configured product without creating billing or trial state", async () => {
    const f = await fixture();
    const result = await f.client.getApplicationBillingProduct(f.slotKey);
    expect(result.data).toEqual({
      slotKey: f.slotKey,
      appId: f.identity.appId,
      appName: "Independent app",
      productFamilyKey: "main",
      environment: "test",
    });
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS total FROM app_billing_accounts WHERE eligibility_principal_id=$1",
          [f.userId],
        )
      ).rows[0].total,
    ).toBe(0);
    expect(
      (
        await db.query(
          "SELECT credit_balance::text AS balance FROM organizations WHERE id=$1",
          [org],
        )
      ).rows[0].balance,
    ).toMatch(/^0(?:\.0+)?$/);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS total FROM billing_subscriptions s JOIN app_billing_scopes scope ON scope.id=s.billing_scope_id WHERE scope.app_id=$1",
          [f.identity.appId],
        )
      ).rows[0].total,
    ).toBe(0);
  });
  test("missing, disabled and wrong-mode slots remain unavailable instead of selecting another product", async () => {
    const f = await fixture();
    await expect(
      f.client.getApplicationBillingProduct("missing-product"),
    ).rejects.toMatchObject({
      statusCode: 503,
      errorBody: { code: "APP_BILLING_APPLICATION_SLOT_UNAVAILABLE" },
    });
    const token = createPlaywrightTestSessionToken(f.userId, org, env);
    const response = await routes.request(
      `https://cloud.eliza.app/api/v1/billing/application-slots/${f.slotKey}`,
      { headers: { cookie: `eliza-test-session=${token}` } },
      { ...env, APP_BILLING_ENVIRONMENT: "live" },
    );
    expect(response.status).toBe(500);
    const { readAppBillingApplicationProduct } = await import(
      "@/db/repositories/app-billing-application-slots"
    );
    await expect(
      readAppBillingApplicationProduct({ slotKey: f.slotKey, livemode: true }),
    ).rejects.toMatchObject({
      code: "APP_BILLING_APPLICATION_SLOT_UNAVAILABLE",
    });
    await db.query(
      "UPDATE app_billing_application_slots SET disabled_at=now() WHERE slot_key=$1",
      [f.slotKey],
    );
    await expect(
      f.client.getApplicationBillingProduct(f.slotKey),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
  test("app review and anonymous callers cannot advertise an available product", async () => {
    const f = await fixture();
    await db.query("UPDATE apps SET is_approved=false WHERE id=$1", [
      f.identity.appId,
    ]);
    await expect(
      f.client.getApplicationBillingProduct(f.slotKey),
    ).rejects.toMatchObject({ statusCode: 503 });
    const response = await routes.request(
      `https://cloud.eliza.app/api/v1/billing/application-slots/${f.slotKey}`,
      {},
      env,
    );
    expect(response.status).toBe(401);
  });
});
