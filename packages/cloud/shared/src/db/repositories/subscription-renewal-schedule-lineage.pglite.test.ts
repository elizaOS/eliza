/** Exercises actual queue, migrated renewal publication and funding ledger with only read-only Stripe transport controlled. */
import { afterAll, beforeAll, expect, mock, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { installCancellationTestSchema } from "./subscription-cancellation-test-fixture";
import { seedRenewalTestAccount } from "./subscription-renewal-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.ENVIRONMENT = "local";
process.env.STRIPE_SECRET_KEY = "sk_test_renewalfixture";
process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro";
process.env.STRIPE_PRO_PRODUCT_ID = "prod_pro";
setDefaultTimeout(120000);
let fixture: Awaited<ReturnType<typeof seedRenewalTestAccount>>;
let reads = 0;
async function read<T>(value: T) {
  reads++;
  const copy = structuredClone(value);
  return copy;
}
mock.module("../../lib/stripe", () => ({
  requireStripe: () => ({
    invoices: { retrieve: async () => read(fixture.invoice) },
    subscriptions: { retrieve: async () => read(fixture.subscription) },
    customers: { retrieve: async () => read(fixture.customer) },
    paymentIntents: { retrieve: async () => read(fixture.paymentIntent) },
    charges: { retrieve: async () => read(fixture.charge) },
    prices: { retrieve: async () => read(fixture.price) },
    products: { retrieve: async () => read(fixture.product) },
  }),
}));
let client: typeof import("../client");
let queue: typeof import("../../../../api/src/queue/stripe-event");
beforeAll(async () => {
  client = await import("../client");
  await installCancellationTestSchema((sql) => client.getPgliteClientForTests().exec(sql));
  queue = await import("../../../../api/src/queue/stripe-event");
});
afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
});
function delivery(id = `evt_${randomUUID().replaceAll("-", "")}`) {
  const event: import("stripe").default.InvoicePaidEvent = JSON.parse(
    JSON.stringify({
      id,
      object: "event",
      type: "invoice.paid",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      data: { object: fixture.invoice },
    }),
  );
  return {
    attempts: 1,
    body: {
      kind: "stripe.event" as const,
      eventId: event.id,
      eventType: event.type,
      event,
      receivedAt: Date.now(),
    },
  };
}
async function seed() {
  fixture = await seedRenewalTestAccount();
  reads = 0;
}
async function rows(table: string) {
  return (
    await client
      .getPgliteClientForTests()
      .query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE organization_id=$1`, [
        fixture.source.organization_id,
      ])
  ).rows;
}
async function ownedResumeBeforeRenewal() {
  await seed();
  const authority = (await import("./subscription-authority")).subscriptionAuthorityRepository;
  const entitlements = (await import("./subscription-entitlements"))
    .subscriptionEntitlementsRepository;
  const cancellation = await import("./subscription-cancellation");
  const boundary = Math.floor(Date.now() / 1000) + 8;
  const source = (
    await authority.advance({
      organizationId: fixture.source.organization_id,
      subscriptionId: fixture.source.id,
      expectedRevision: 2,
      source: "reconciliation",
      observation: "authoritative_provider_retrieval",
      values: {
        ...fixture.source,
        current_period_start: new Date((boundary - 86400) * 1000),
        current_period_end: new Date(boundary * 1000),
      },
    })
  ).subscription;
  await entitlements.rebuild({
    organizationId: source.organization_id,
    sourceSubscriptionId: source.id,
    sourceSubscriptionRevision: 3,
    expectedProjectionRevision: 2,
  });
  const actor = (
    await client
      .getPgliteClientForTests()
      .query<{ id: string }>("SELECT id FROM users WHERE organization_id=$1", [
        source.organization_id,
      ])
  ).rows[0];
  const base = {
    organizationId: source.organization_id,
    subscriptionId: source.id,
    actorId: actor!.id,
  };
  const raw = {
    ...fixture.subscription,
    current_period_start: boundary - 86400,
    current_period_end: boundary,
    cancel_at_period_end: true,
    cancel_at: boundary,
    canceled_at: Math.floor(Date.now() / 1000),
  };
  const c = await cancellation.prepareCancellation({
    ...base,
    expectedSubscriptionRevision: 3,
    idempotencyKey: randomUUID(),
  });
  const cc = await cancellation.claimCancellation({ ...base, commandId: c.id });
  if (!cc) throw new Error("Expected cancellation claim");
  await cancellation.finalizeCancellation(base, cc, raw);
  const u = await cancellation.prepareCancellation(
    { ...base, expectedSubscriptionRevision: 4, idempotencyKey: randomUUID() },
    "resume",
  );
  const uc = await cancellation.claimCancellation({ ...base, commandId: u.id }, "resume");
  if (!uc) throw new Error("Expected resume claim");
  await cancellation.finalizeCancellation(base, uc, {
    ...raw,
    cancel_at_period_end: false,
    cancel_at: null,
  });
  fixture.subscription = {
    ...fixture.subscription,
    current_period_start: boundary,
    current_period_end: boundary + 30 * 86400,
    canceled_at: raw.canceled_at,
  };
  fixture.invoice.lines.data[0].period = { start: boundary, end: boundary + 30 * 86400 };
  fixture.invoice.status_transitions.paid_at = boundary;
  await Bun.sleep(Math.max(0, boundary * 1000 - Date.now() + 100));
  return { base, boundary, authority, cancellation, entitlements };
}
test("paid renewal preserves schedule ownership for fresh recancel without changing consumed funding", async () => {
  const { base, cancellation } = await ownedResumeBeforeRenewal();
  const event = delivery();
  expect(await queue.processStripeEvent(event)).toBe("ack");
  expect((await rows("billing_subscriptions"))[0]?.lifecycle_revision).toBe(6);
  const funding = (await import("../../lib/services/subscription-funding"))
    .subscriptionFundingService;
  await funding.reserve({
    organizationId: base.organizationId,
    logicalOperationId: `lineage:${randomUUID()}`,
    operation: "ai_inference",
    amount: "1.000000",
    description: "lineage funding proof",
    reservationTtlMs: 60000,
  });
  const periods = await rows("subscription_allowance_periods");
  const grants = await rows("subscription_allowance_transactions");
  expect(periods[0]?.available_amount).toBe("24.000000");
  const command = await cancellation.prepareCancellation({
    ...base,
    expectedSubscriptionRevision: 6,
    idempotencyKey: randomUUID(),
  });
  const claim = await cancellation.claimCancellation({ ...base, commandId: command.id });
  expect(claim).not.toBeNull();
  const raw = {
    ...fixture.subscription,
    cancel_at_period_end: true,
    cancel_at: fixture.subscription.current_period_end,
    canceled_at: Math.floor(Date.now() / 1000),
  };
  await cancellation.finalizeCancellation(base, claim!, raw);
  const current = (await rows("billing_subscriptions"))[0];
  expect(current?.lifecycle_revision).toBe(7);
  expect(current?.cancel_at_period_end).toBe(true);
  expect(await rows("subscription_allowance_periods")).toEqual(periods);
  expect(await rows("subscription_allowance_transactions")).toEqual(grants);
  const readsBeforeReplay = reads;
  expect(await queue.processStripeEvent(event)).toBe("ack");
  expect(reads).toBe(readsBeforeReplay);
  expect((await rows("billing_subscriptions"))[0]?.lifecycle_revision).toBe(7);
});
test("period movement with a grant but no applied paid-renewal receipt remains unowned", async () => {
  const { base, boundary, authority, cancellation, entitlements } =
    await ownedResumeBeforeRenewal();
  const current = await authority.findById(base.organizationId, base.subscriptionId);
  const advanced = (
    await authority.advance({
      organizationId: base.organizationId,
      subscriptionId: base.subscriptionId,
      expectedRevision: 5,
      source: "webhook",
      observation: "authoritative_provider_retrieval",
      values: {
        ...current!,
        current_period_start: new Date(boundary * 1000),
        current_period_end: new Date((boundary + 30 * 86400) * 1000),
        last_provider_event_id: `evt_${randomUUID().replaceAll("-", "")}`,
        last_provider_event_created_at: new Date(),
        provider_object_digest: "a".repeat(64),
      },
    })
  ).subscription;
  await entitlements.rebuild({
    organizationId: base.organizationId,
    sourceSubscriptionId: base.subscriptionId,
    sourceSubscriptionRevision: 6,
    expectedProjectionRevision: 5,
  });
  const { writeTransaction } = await import("../helpers");
  const { subscriptionAllowanceRepository } = await import("./subscription-allowance");
  await writeTransaction(async (tx) => {
    const { sql } = await import("drizzle-orm");
    await tx.execute(sql`SELECT id FROM organizations WHERE id=${base.organizationId} FOR UPDATE`);
    await subscriptionAllowanceRepository.grantRenewalInTransaction(tx, {
      source: advanced,
      invoiceId: fixture.invoice.id,
      requestDigest: "b".repeat(64),
      databaseNow: new Date(),
    });
  });
  const before = await rows("billing_subscription_commands");
  await expect(
    cancellation.prepareCancellation({
      ...base,
      expectedSubscriptionRevision: 6,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({
    code: "SUBSCRIPTION_CANCELLATION_REOBSERVE",
    context: { reason: "unowned_schedule_transition" },
  });
  expect(await rows("billing_subscription_commands")).toEqual(before);
  expect((await rows("billing_subscriptions"))[0]?.cancel_at_period_end).toBe(false);
});
