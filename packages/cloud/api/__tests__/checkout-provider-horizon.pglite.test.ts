/** Real route, order service and PGlite; only authentication/customer/provider boundaries are local. */
import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import type Stripe from "stripe";
import { installStripeCheckoutTestSchema } from "../../shared/src/lib/services/test-support/stripe-checkout-test-schema";

const organizationId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000001";
const epoch = Date.parse("2026-01-01T00:00:00Z");
const hour = 3_600_000;
const env = {
  NEXT_PUBLIC_APP_URL: "https://cloud.eliza.app",
  STRIPE_CURRENCY: "usd",
};
const principal = {
  id: userId,
  organization_id: organizationId,
  organization: { stripe_customer_id: "cus_test" },
};
let db: typeof import("@elizaos/cloud-shared/db/client");
let service: typeof import("@elizaos/cloud-shared/lib/services/stripe-checkout-orders").stripeCheckoutOrdersService;
let route: Hono;
let beforeCustomer: (() => void) | undefined;
const calls: Array<{ at: number; key: string | undefined }> = [];
const searches: Stripe.Checkout.SessionListParams[] = [];
type RecoverySession = Pick<
  Stripe.Checkout.Session,
  "id" | "created" | "client_reference_id" | "metadata" | "url"
>;
let sessions: RecoverySession[] = [];

mock.module("@elizaos/cloud-shared/auth", () => ({
  requireUserWithOrg: async () => principal,
  requireCurrentBillingManagerSession: async () => principal,
}));
mock.module(
  "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare",
  () => ({
    moneyRateLimit:
      () => async (_context: unknown, next: () => Promise<void>) =>
        next(),
    RateLimitPresets: { STRICT: {} },
  }),
);
mock.module(
  "@elizaos/cloud-shared/lib/services/stripe-customer-authority",
  () => ({
    stripeCustomerAuthorityService: {
      ensure: async () => {
        beforeCustomer?.();
        return "cus_test";
      },
    },
  }),
);
mock.module("@elizaos/cloud-shared/lib/stripe", () => ({
  isStripeConfigured: () => true,
  requireStripe: () => ({
    checkout: {
      sessions: {
        create: async (
          _params: Stripe.Checkout.SessionCreateParams,
          options: { idempotencyKey?: string },
        ) => {
          calls.push({ at: Date.now(), key: options.idempotencyKey });
          throw new Error("Ambiguous provider response");
        },
        list: async (params: Stripe.Checkout.SessionListParams) => {
          searches.push(params);
          const range = params.created as { gte: number; lte: number };
          return {
            data: sessions.filter(
              (session) =>
                session.created >= range.gte && session.created <= range.lte,
            ),
            has_more: false,
          };
        },
      },
    },
  }),
}));

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL = "pglite://memory";
  db = await import("@elizaos/cloud-shared/db/client");
  ({ stripeCheckoutOrdersService: service } = await import(
    "@elizaos/cloud-shared/lib/services/stripe-checkout-orders"
  ));
  await installStripeCheckoutTestSchema((query) =>
    db.getPgliteClientForTests().exec(query),
  );
  await db.dbWrite.execute(
    sql`INSERT INTO organizations(id,name,slug,stripe_customer_id) VALUES (${organizationId}, 'Test', 'test', 'cus_test')`,
  );
  await db.dbWrite.execute(
    sql`INSERT INTO users(id,organization_id) VALUES (${userId}, ${organizationId})`,
  );
  route = new Hono().route(
    "/checkout",
    (await import("../stripe/create-checkout-session/route")).default,
  );
}, 30_000);

beforeEach(async () => {
  setSystemTime(epoch);
  calls.length = 0;
  searches.length = 0;
  sessions = [];
  beforeCustomer = undefined;
  await db.dbWrite.execute(sql`DELETE FROM stripe_checkout_orders`);
});
afterAll(async () => {
  setSystemTime();
  await db.closeDatabaseConnectionsForTests();
});

function request(key = "request-retry-horizon") {
  return route.request(
    "https://cloud.eliza.app/checkout",
    {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ amount: 5 }),
    },
    env,
  );
}
async function order(key = "request-retry-horizon") {
  const result = await db.dbWrite.execute(
    sql`SELECT id FROM stripe_checkout_orders WHERE client_request_key=${key}`,
  );
  const id = (result.rows[0] as { id: string }).id;
  const value = await service.get(id);
  if (!value) throw new Error("Missing test order");
  return value;
}
function providerSession(
  id: string,
  orderId: string,
  at: number,
): RecoverySession {
  return {
    id,
    created: Math.floor(at / 1000),
    client_reference_id: orderId,
    metadata: { checkout_order_id: orderId },
    url: `https://checkout.stripe.test/${id}`,
  };
}

test("repeated failures at0/22/44h never reset the original23-hour creation cutoff", async () => {
  for (const elapsed of [0, 22, 44]) {
    setSystemTime(epoch + elapsed * hour);
    expect((await request()).status).toBe(500);
  }
  expect(calls.map((call) => (call.at - epoch) / hour)).toEqual([0, 22]);
  expect(calls[0]?.key).toBe(calls[1]?.key);
  const row = await order();
  expect(row.provider_started_at?.getTime()).toBe(epoch);
  expect(row.updated_at.getTime()).toBe(epoch + 22 * hour);
  expect(searches[0]?.created).toEqual(searches[1]?.created);
  await expect(service.markProviderStarted(row.id)).rejects.toThrow(
    "read-only reconciliation",
  );
});

test("a delayed first dispatch receives its own full original retry window", async () => {
  beforeCustomer = () => setSystemTime(epoch + 26 * hour);
  expect((await request()).status).toBe(500);
  beforeCustomer = undefined;
  setSystemTime(epoch + 48 * hour);
  expect((await request()).status).toBe(500);
  setSystemTime(epoch + 70 * hour);
  expect((await request()).status).toBe(500);
  const row = await order();
  expect(row.created_at.getTime()).toBe(epoch);
  expect(row.provider_started_at?.getTime()).toBe(epoch + 26 * hour);
  expect(calls.map((call) => (call.at - epoch) / hour)).toEqual([26, 48]);
});

/** Override only the database clock so application and primary time can diverge. */
async function withDatabaseClock(at: number, run: () => Promise<void>) {
  const pg = db.getPgliteClientForTests();
  await pg.exec(`
    CREATE SCHEMA checkout_test_clock;
    CREATE TABLE checkout_test_clock.time(value timestamptz NOT NULL);
    CREATE FUNCTION checkout_test_clock.clock_timestamp() RETURNS timestamptz
      LANGUAGE sql VOLATILE AS 'SELECT value FROM checkout_test_clock.time';
    SET search_path=checkout_test_clock,public,pg_catalog;
  `);
  try {
    await db.dbWrite.execute(
      sql`INSERT INTO checkout_test_clock.time(value) VALUES (${new Date(at)})`,
    );
    await run();
  } finally {
    await pg.exec(
      "SET search_path=public; DROP SCHEMA checkout_test_clock CASCADE",
    );
  }
}

test("first dispatch is timestamped by the primary despite an application clock ahead", async () => {
  setSystemTime(epoch + 48 * hour);
  await withDatabaseClock(epoch, async () => {
    expect((await request()).status).toBe(500);
    expect((await order()).provider_started_at?.getTime()).toBe(epoch);
    expect(calls).toHaveLength(1);
  });
});

test("a slow application clock cannot authorize an expired ambiguous or started retry", async () => {
  await withDatabaseClock(epoch, async () => {
    expect((await request()).status).toBe(500);
    const row = await order();
    await db.dbWrite.execute(
      sql`UPDATE checkout_test_clock.time SET value=${new Date(epoch + 25 * hour)}`,
    );
    setSystemTime(epoch + hour);
    expect((await request()).status).toBe(500);
    expect(calls).toHaveLength(1);
    await db.dbWrite.execute(
      sql`UPDATE stripe_checkout_orders SET status='provider_started' WHERE id=${row.id}`,
    );
    await expect(service.markProviderStarted(row.id)).rejects.toThrow(
      "read-only reconciliation",
    );
    expect((await order()).provider_started_at?.getTime()).toBe(epoch);
  });
});

test("recovery searches the entire original retry window, including a late accepted retry", async () => {
  await request();
  setSystemTime(epoch + 22 * hour);
  await request();
  const row = await order();
  sessions = [providerSession("cs_late_retry", row.id, epoch + 22 * hour)];
  setSystemTime(epoch + 44 * hour);
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ sessionId: "cs_late_retry" });
  expect(calls).toHaveLength(2);
  expect((await order()).provider_started_at?.getTime()).toBe(epoch);
});

async function legacyOrder() {
  // Existing rows deliberately retain NULL on rollout; this represents an old
  // writer's two transitions, not a fabricated first provider timestamp.
  beforeCustomer = () => {};
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify({
        purchaseType: "custom_amount",
        creditPackId: null,
        creditsToGrant: "5.000000",
        chargeAmountCents: 500,
        currency: "usd",
        successUrl:
          "https://cloud.eliza.app/cloud/billing/success?session_id={CHECKOUT_SESSION_ID}&from=settings",
        cancelUrl: "https://cloud.eliza.app/cloud/billing",
        returnUrl: "settings",
      }),
    ),
  );
  const row = await service.create({
    organizationId,
    initiatedByUserId: userId,
    clientRequestKey: "request-retry-horizon",
    requestDigest: Buffer.from(digest).toString("hex"),
    purchaseType: "custom_amount",
    creditsToGrant: "5.000000",
    chargeAmountCents: 500,
    currency: "usd",
    stripeCustomerId: "cus_test",
  });
  await db.dbWrite.execute(
    sql`UPDATE stripe_checkout_orders SET status='provider_started' WHERE id=${row.id}`,
  );
  await db.dbWrite.execute(
    sql`UPDATE stripe_checkout_orders SET status='provider_ambiguous', updated_at=${new Date(epoch + 40 * hour)} WHERE id=${row.id}`,
  );
  return row;
}

test("legacy ambiguous orders remain read-only when original creation time is unknown", async () => {
  await legacyOrder();
  setSystemTime(epoch + 44 * hour);
  expect((await request()).status).toBe(500);
  expect(calls).toHaveLength(0);
  expect((await order()).provider_started_at).toBeNull();
  await expect(
    service.markProviderStarted((await order()).id),
  ).rejects.toThrow();
});

test("legacy read-only discovery can recover an old Session outside the last-update window", async () => {
  const row = await legacyOrder();
  sessions = [providerSession("cs_original", row.id, epoch + hour)];
  setSystemTime(epoch + 44 * hour);
  expect((await request()).status).toBe(200);
  expect(calls).toHaveLength(0);
  expect((await order()).stripe_checkout_session_id).toBe("cs_original");
  expect((await order()).provider_started_at).toBeNull();
});

test("multiple matching historical Sessions require reconciliation instead of choosing one", async () => {
  const row = await legacyOrder();
  sessions = [
    providerSession("cs_first", row.id, epoch + hour),
    providerSession("cs_second", row.id, epoch + 25 * hour),
  ];
  setSystemTime(epoch + 44 * hour);
  expect((await request()).status).toBe(500);
  expect(calls).toHaveLength(0);
  expect((await order()).stripe_checkout_session_id).toBeNull();
});
