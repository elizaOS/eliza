/** Exercises the real checkout journal and Stripe request construction with a controlled provider transport and migrated PGlite. */
import { afterAll, beforeAll, expect, mock, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { installCancellationTestSchema } from "../../db/repositories/subscription-cancellation-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.ENVIRONMENT = "local";
process.env.STRIPE_SECRET_KEY = "sk_test_checkoutfixture";
process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro";
process.env.STRIPE_PRO_PRODUCT_ID = "prod_pro";
process.env.NEXT_PUBLIC_APP_URL = "https://cloud.eliza.app";
setDefaultTimeout(120000);
let customerId: string;
let sessions: Array<Record<string, unknown>> = [];
let calls: Array<{ params: Stripe.Checkout.SessionCreateParams; key: string }> = [];
let loseResponse = false;
mock.module("./stripe-customer-authority", () => ({
  stripeCustomerAuthorityService: { ensure: async () => customerId },
}));
mock.module("../stripe", () => ({
  requireStripe: () => ({
    prices: {
      retrieve: async (id: string) => ({
        id,
        active: true,
        currency: "usd",
        unit_amount: id === "price_plus" ? 3000 : 10000,
        type: "recurring",
        billing_scheme: "per_unit",
        transform_quantity: null,
        product: id === "price_plus" ? "prod_plus" : "prod_pro",
        livemode: false,
        recurring: {
          interval: "month",
          interval_count: 1,
          trial_period_days: null,
          usage_type: "licensed",
        },
      }),
    },
    products: { retrieve: async () => ({ active: true, livemode: false }) },
    checkout: {
      sessions: {
        list: async function* () {
          for (const session of sessions) yield session;
        },
        create: async (
          params: Stripe.Checkout.SessionCreateParams,
          options: { idempotencyKey: string },
        ) => {
          calls.push({ params, key: options.idempotencyKey });
          const session = {
            id: `cs_test_${randomUUID().replaceAll("-", "")}`,
            mode: params.mode,
            status: "open",
            payment_status: "unpaid",
            customer: params.customer,
            subscription: null,
            invoice: null,
            client_reference_id: params.client_reference_id,
            livemode: false,
            metadata: params.metadata,
            url: "https://checkout.stripe.com/c/pay/test",
          };
          sessions.push(session);
          if (loseResponse) throw new Error("provider response lost after creation");
          return session;
        },
      },
    },
  }),
}));
let client: typeof import("../../db/client");
let submit: typeof import("./subscription-checkout").submitSubscriptionCheckout;
beforeAll(async () => {
  client = await import("../../db/client");
  await installCancellationTestSchema((sql) => client.getPgliteClientForTests().exec(sql));
  submit = (await import("./subscription-checkout")).submitSubscriptionCheckout;
});
afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
});
async function seed() {
  const organizationId = randomUUID(),
    actorId = randomUUID();
  customerId = `cus_${organizationId.replaceAll("-", "")}`;
  const db = client.getPgliteClientForTests();
  await db.query("INSERT INTO organizations(id,stripe_customer_id) VALUES($1,$2)", [
    organizationId,
    customerId,
  ]);
  await db.query("INSERT INTO users(id,organization_id,role) VALUES($1,$2,'owner')", [
    actorId,
    organizationId,
  ]);
  sessions = [];
  calls = [];
  loseResponse = false;
  return {
    organizationId,
    actorId,
    planKey: "plus_monthly" as const,
    idempotencyKey: randomUUID(),
  };
}
test("lost provider response recovers the same session without a second purchase", async () => {
  const input = await seed();
  loseResponse = true;
  await expect(submit(input, async () => {})).rejects.toThrow("response lost");
  loseResponse = false;
  const recovered = await submit(input, async () => {});
  expect(recovered.status).toBe("open");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.params).toMatchObject({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: "price_plus", quantity: 1 }],
    allow_promotion_codes: false,
  });
  expect((await submit({ ...input, idempotencyKey: randomUUID() }, async () => {})).status).toBe(
    "open",
  );
  expect(calls).toHaveLength(1);
});
test("lost authorization before provider dispatch creates no Checkout session", async () => {
  const input = await seed();
  let checks = 0;
  await expect(
    submit(input, async () => {
      if (++checks === 3) throw new Error("membership revoked");
    }),
  ).rejects.toThrow("membership revoked");
  expect(calls).toHaveLength(0);
});
test("verified expiry releases the purchase fence before a fresh checkout", async () => {
  const input = await seed();
  await submit(input, async () => {});
  sessions[0]!.status = "expired";
  expect((await submit(input, async () => {})).status).toBe("expired");
  expect((await submit({ ...input, idempotencyKey: randomUUID() }, async () => {})).status).toBe(
    "open",
  );
  expect(calls).toHaveLength(2);
});
