/** Exercises atomic initial subscription activation, duplicate delivery, payment rejection and real allowance spending against migrated PGlite. */
import { afterAll, beforeAll, expect, mock, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { installCancellationTestSchema } from "./subscription-cancellation-test-fixture";
import { seedRenewalTestAccount } from "./subscription-renewal-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.ENVIRONMENT = "local";
process.env.STRIPE_SECRET_KEY = "sk_test_checkoutfixture";
process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro";
process.env.STRIPE_PRO_PRODUCT_ID = "prod_pro";
setDefaultTimeout(120000);
let providerFixture: Awaited<ReturnType<typeof seed>>;
mock.module("../../lib/stripe", () => ({
  requireStripe: () => ({
    accounts: { retrieve: async () => ({ id: "acct_checkoutfixture" }) },
    checkout: {
      sessions: {
        retrieve: async () => providerFixture.session,
        list: async () => ({ data: [providerFixture.session], has_more: false }),
      },
    },
    invoices: { retrieve: async () => providerFixture.invoice },
    subscriptions: { retrieve: async () => providerFixture.subscription },
    customers: { retrieve: async () => providerFixture.customer },
    paymentIntents: { retrieve: async () => providerFixture.paymentIntent },
    charges: { retrieve: async () => providerFixture.charge },
  }),
}));

let client: typeof import("../client");
let finalize: typeof import("./subscription-checkout-finalization").finalizeSubscriptionCheckout;
beforeAll(async () => {
  client = await import("../client");
  await installCancellationTestSchema((sql) => client.getPgliteClientForTests().exec(sql));
  finalize = (await import("./subscription-checkout-finalization")).finalizeSubscriptionCheckout;
});
afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
});
async function seed(planKey: "plus_monthly" | "pro_monthly" = "plus_monthly") {
  const fixture = await seedRenewalTestAccount();
  const orgId = randomUUID(),
    actorId = randomUUID();
  const customerId = `cus_${orgId.replaceAll("-", "")}`;
  const db = client.getPgliteClientForTests();
  await db.query("INSERT INTO organizations(id,stripe_customer_id) VALUES($1,$2)", [
    orgId,
    customerId,
  ]);
  await db.query("INSERT INTO users(id,organization_id,role) VALUES($1,$2,'owner')", [
    actorId,
    orgId,
  ]);
  const operations = (await import("./subscription-billing-operations"))
    .subscriptionBillingOperationsRepository;
  const binding = (
    await import("../../lib/services/subscription-catalog")
  ).resolveSubscriptionProviderBinding(process.env, planKey, "v1");
  const commandId = randomUUID();
  const command = (
    await operations.enqueueCommand({
      id: commandId,
      organizationId: orgId,
      requestedByUserId: actorId,
      kind: "checkout",
      subscriptionId: null,
      targetPlanKey: planKey,
      expectedSubscriptionRevision: null,
      idempotencyKey: randomUUID(),
      providerIdempotencyKey: randomUUID(),
      requestDigest: "b".repeat(64),
      checkoutContract: {
        version: 1,
        catalogVersion: "v1",
        planKey,
        accountId: "acct_checkoutfixture",
        expectedLivemode: false,
        priceId: binding.priceId,
        productId: binding.productId,
        params: {
          mode: "subscription",
          customer: customerId,
          client_reference_id: commandId,
          line_items: [{ price: binding.priceId, quantity: 1 }],
          payment_method_types: ["card"],
          allow_promotion_codes: false,
          automatic_tax: { enabled: false },
          metadata: { app: "eliza-cloud", organization_id: orgId, command_id: commandId },
          subscription_data: {
            metadata: { app: "eliza-cloud", organization_id: orgId, command_id: commandId },
          },
          success_url:
            "https://cloud.eliza.app/cloud/billing?subscription_session_id={CHECKOUT_SESSION_ID}",
          cancel_url: "https://cloud.eliza.app/cloud/billing",
          expires_at: Math.floor(Date.now() / 1000) + 86400,
        },
      },
      now: new Date(),
    })
  ).value;
  await operations.markCommandOutcomeUnknown({
    organizationId: orgId,
    commandId: command.id,
    expectedStateRevision: command.state_revision,
    expectedExecutionGeneration: 0,
  });
  // These provider identities must not overlap the fixture's historical subscription.
  const subId = `sub_${orgId.replaceAll("-", "")}`,
    itemId = `si_${orgId.replaceAll("-", "")}`;
  fixture.invoice.billing_reason = "subscription_create";
  fixture.invoice.customer = customerId;
  fixture.invoice.subscription = subId;
  fixture.invoice.lines.data[0]!.subscription = subId;
  fixture.invoice.lines.data[0]!.subscription_item = itemId;
  fixture.subscription.id = subId;
  fixture.subscription.customer = customerId;
  fixture.subscription.items.data[0]!.id = itemId;
  fixture.customer.id = customerId;
  fixture.paymentIntent.customer = customerId;
  fixture.charge.customer = customerId;
  const session = {
    id: `cs_test_${orgId.replaceAll("-", "")}`,
    mode: "subscription",
    status: "complete",
    payment_status: "paid",
    customer: customerId,
    subscription: subId,
    invoice: fixture.invoice.id,
    livemode: false,
    client_reference_id: command.id,
    metadata: { app: "eliza-cloud", organization_id: orgId, command_id: command.id },
  };
  return { ...fixture, session, orgId, command, providerAccountId: "acct_checkoutfixture" };
}
async function count(orgId: string, table: string) {
  return (
    await client
      .getPgliteClientForTests()
      .query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM ${table} WHERE organization_id=$1`,
        [orgId],
      )
  ).rows[0]!.count;
}
test("first captured payment grants spendable allowance once across concurrent retries", async () => {
  const input = await seed();
  const results = await Promise.all([finalize(input), finalize(input)]);
  expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  expect(await count(input.orgId, "billing_subscriptions")).toBe(1);
  expect(await count(input.orgId, "subscription_allowance_periods")).toBe(1);
  const funding = (await import("../../lib/services/subscription-funding"))
    .subscriptionFundingService;
  const operationId = randomUUID();
  await funding.reserve({
    organizationId: input.orgId,
    logicalOperationId: operationId,
    operation: "ai_inference",
    amount: "1.000000",
    description: "checkout allowance proof",
    reservationTtlMs: 60000,
  });
  await funding.settle({
    organizationId: input.orgId,
    logicalOperationId: operationId,
    operation: "ai_inference",
    actualAmount: "1.000000",
    occurredAt: new Date(),
  });
  expect((await finalize(input)).replayed).toBe(true);
  const period = (
    await client
      .getPgliteClientForTests()
      .query<{ granted_amount: string; settled_amount: string }>(
        "SELECT granted_amount,settled_amount FROM subscription_allowance_periods WHERE organization_id=$1",
        [input.orgId],
      )
  ).rows[0]!;
  expect(period).toMatchObject({ granted_amount: "25.000000", settled_amount: "1.000000" });
});
for (const invalid of ["unpaid", "refunded", "customer", "plan", "fenced"] as const) {
  test(`${invalid} first payment cannot publish subscription or allowance`, async () => {
    const input = await seed();
    if (invalid === "unpaid") input.session.payment_status = "unpaid";
    if (invalid === "refunded") input.charge.amount_refunded = 3000;
    if (invalid === "customer") input.session.customer = "cus_wrong";
    if (invalid === "plan") input.invoice.lines.data[0]!.price.id = "price_pro";
    if (invalid === "fenced")
      await client
        .getPgliteClientForTests()
        .query("UPDATE organizations SET paid_work_fenced_at=now() WHERE id=$1", [input.orgId]);
    await expect(finalize(input)).rejects.toThrow();
    expect(await count(input.orgId, "billing_subscriptions")).toBe(0);
    expect(await count(input.orgId, "subscription_allowance_periods")).toBe(0);
  });
}
test("projection failure rolls back the first payment and leaves checkout recoverable", async () => {
  const input = await seed();
  const db = client.getPgliteClientForTests();
  await db.exec(`CREATE FUNCTION reject_checkout_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced projection failure'; END $$;
    CREATE TRIGGER reject_checkout_projection BEFORE UPDATE ON organization_entitlements FOR EACH ROW EXECUTE FUNCTION reject_checkout_projection();`);
  try {
    await expect(finalize(input)).rejects.toThrow();
    expect(await count(input.orgId, "billing_subscriptions")).toBe(0);
    expect(await count(input.orgId, "subscription_allowance_periods")).toBe(0);
  } finally {
    await db.exec(
      "DROP TRIGGER reject_checkout_projection ON organization_entitlements; DROP FUNCTION reject_checkout_projection();",
    );
  }
  expect((await finalize(input)).replayed).toBe(false);
});
test("Pro first payment publishes its own allowance and higher entitlement", async () => {
  const input = await seed("pro_monthly");
  input.invoice.amount_paid =
    input.invoice.amount_due =
    input.invoice.total =
    input.invoice.subtotal =
      10000;
  input.invoice.lines.data[0]!.amount = 10000;
  input.invoice.lines.data[0]!.price = { id: "price_pro", product: "prod_pro" };
  input.subscription.items.data[0]!.price.id = "price_pro";
  input.subscription.items.data[0]!.price.product = "prod_pro";
  input.subscription.items.data[0]!.price.unit_amount = 10000;
  input.paymentIntent.amount = input.paymentIntent.amount_received = 10000;
  input.charge.amount = input.charge.amount_captured = 10000;
  await finalize(input);
  const row = (
    await client
      .getPgliteClientForTests()
      .query<{ granted_amount: string }>(
        "SELECT granted_amount FROM subscription_allowance_periods WHERE organization_id=$1",
        [input.orgId],
      )
  ).rows[0]!;
  expect(row.granted_amount).toBe("90.000000");
});

for (const invoiceFirst of [true, false]) {
  test(`real queue activates once when ${invoiceFirst ? "invoice" : "checkout"} arrives first`, async () => {
    providerFixture = await seed();
    const queue = await import("../../../../api/src/queue/stripe-event");
    const deliveries = [
      { type: "checkout.session.completed", object: providerFixture.session },
      { type: "invoice.paid", object: providerFixture.invoice },
    ];
    if (invoiceFirst) deliveries.reverse();
    for (const delivery of deliveries) {
      const event: import("stripe").default.Event = JSON.parse(
        JSON.stringify({
          id: `evt_${randomUUID().replaceAll("-", "")}`,
          object: "event",
          type: delivery.type,
          created: Math.floor(Date.now() / 1000),
          livemode: false,
          data: { object: delivery.object },
        }),
      );
      expect(
        await queue.processStripeEvent({
          attempts: 1,
          body: {
            kind: "stripe.event",
            eventId: event.id,
            eventType: event.type,
            event,
            receivedAt: Date.now(),
          },
        }),
      ).toBe("ack");
    }
    expect(await count(providerFixture.orgId, "billing_subscriptions")).toBe(1);
    expect(await count(providerFixture.orgId, "subscription_allowance_periods")).toBe(1);
  });
}

test("paid original checkout survives binding rotation and grants exactly once", async () => {
  const input = await seed();
  const original = process.env.STRIPE_PLUS_MONTHLY_PRICE_ID;
  process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plusRotated";
  try {
    expect((await finalize(input)).replayed).toBe(false);
    expect((await finalize(input)).replayed).toBe(true);
    expect(await count(input.orgId, "subscription_allowance_periods")).toBe(1);
  } finally {
    process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = original;
  }
});

test("a different provider account cannot finalize the original checkout", async () => {
  const input = await seed();
  await expect(finalize({ ...input, providerAccountId: "acct_other" })).rejects.toThrow(
    "authority changed",
  );
  expect(await count(input.orgId, "billing_subscriptions")).toBe(0);
  expect(await count(input.orgId, "subscription_allowance_periods")).toBe(0);
});

test("completed checkout idempotency returns its original command without a new provider request", async () => {
  const input = await seed();
  await finalize(input);
  const { submitSubscriptionCheckout } = await import("../../lib/services/subscription-checkout");
  process.env.NEXT_PUBLIC_APP_URL = "https://cloud.eliza.app";
  const result = await submitSubscriptionCheckout(
    {
      organizationId: input.orgId,
      actorId: input.command.requested_by_user_id,
      planKey: "plus_monthly",
      idempotencyKey: input.command.idempotency_key,
    },
    async () => {},
  );
  expect(result).toEqual({ status: "completed", commandId: input.command.id, checkoutUrl: null });
  expect(await count(input.orgId, "billing_subscription_commands")).toBe(1);
});

test("original paid checkout settles without the unrelated plan configuration", async () => {
  const input = await seed();
  const price = process.env.STRIPE_PRO_MONTHLY_PRICE_ID;
  const product = process.env.STRIPE_PRO_PRODUCT_ID;
  delete process.env.STRIPE_PRO_MONTHLY_PRICE_ID;
  delete process.env.STRIPE_PRO_PRODUCT_ID;
  try {
    expect((await finalize(input)).replayed).toBe(false);
    expect((await finalize(input)).replayed).toBe(true);
    expect(await count(input.orgId, "subscription_allowance_periods")).toBe(1);
  } finally {
    process.env.STRIPE_PRO_MONTHLY_PRICE_ID = price;
    process.env.STRIPE_PRO_PRODUCT_ID = product;
  }
});

test("migrated settled checkout replays without writes and rejects mismatched durable identities", async () => {
  const input = await seed();
  await finalize(input);
  const db = client.getPgliteClientForTests();
  // Retain real paid publication while restoring the pre-contract storage shape.
  await db.exec(`DROP TRIGGER preserve_subscription_checkout_contract ON billing_subscription_commands;
    ALTER TABLE billing_subscription_commands DROP COLUMN checkout_contract;`);
  await db.exec(
    await readFile(
      new URL("../migrations/0397_subscription_checkout_contract.sql", import.meta.url),
      "utf8",
    ),
  );
  const snapshot = async () =>
    Promise.all(
      [
        "billing_subscription_commands",
        "billing_subscriptions",
        "subscription_allowance_periods",
        "organization_entitlements",
      ].map(
        async (table) =>
          (await db.query(`SELECT * FROM ${table} WHERE organization_id=$1`, [input.orgId])).rows,
      ),
    );
  const before = await snapshot();
  expect(before[0]![0]).toMatchObject({ status: "APPLIED", checkout_contract: null });
  const { reconcileSubscriptionCheckout } = await import(
    "../../lib/services/subscription-checkout"
  );
  providerFixture = input;
  const replay = () => reconcileSubscriptionCheckout(input.session.id, input.orgId);
  expect(await Promise.all([replay(), replay()])).toEqual([
    { subscriptionId: input.command.id, replayed: true },
    { subscriptionId: input.command.id, replayed: true },
  ]);
  expect(await snapshot()).toEqual(before);
  for (const mismatch of [
    "invoice",
    "invoiceCustomer",
    "subscription",
    "customer",
    "mode",
    "organization",
  ] as const) {
    providerFixture = structuredClone(input);
    if (mismatch === "invoice") providerFixture.invoice.id = "in_other";
    if (mismatch === "invoiceCustomer") providerFixture.invoice.customer = "cus_other";
    if (mismatch === "subscription") providerFixture.subscription.id = "sub_other";
    if (mismatch === "customer") providerFixture.customer.id = "cus_other";
    if (mismatch === "mode") providerFixture.session.livemode = true;
    if (mismatch === "organization")
      providerFixture.session.metadata.organization_id = randomUUID();
    await expect(replay()).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  }
  providerFixture = input;
  const originalKey = process.env.STRIPE_SECRET_KEY;
  try {
    process.env.STRIPE_SECRET_KEY = "sk_live_wrongmode";
    await expect(replay()).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  } finally {
    process.env.STRIPE_SECRET_KEY = originalKey;
  }
});
