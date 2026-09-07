/** Exercises actual queue, migrated renewal publication and funding ledger with only read-only Stripe transport controlled. */
import { afterAll, beforeAll, expect, mock, setDefaultTimeout, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
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
let afterRead: (() => Promise<void>) | null = null;
async function read<T>(value: T) {
  reads++;
  const copy = structuredClone(value);
  if (afterRead) {
    const action = afterRead;
    afterRead = null;
    await action();
  }
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
  afterRead = null;
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
async function state() {
  return {
    source: await rows("billing_subscriptions"),
    revisions: await rows("billing_subscription_revisions"),
    audit: await rows("organization_policy_audit"),
    reservations: await rows("billing_funding_reservations"),
    allocations: await rows("billing_funding_allocations"),
    credit: await rows("credit_transactions"),
    periods: await rows("subscription_allowance_periods"),
    grants: await rows("subscription_allowance_transactions"),
    authority: await rows("organization_subscription_authorities"),
    projection: await rows("organization_entitlements"),
  };
}
test("captured renewal opens allowance; distinct events replay consumed grant without another generation", async () => {
  await seed();
  const event = delivery();
  expect(await queue.processStripeEvent(event)).toBe("ack");
  const periods = await rows("subscription_allowance_periods");
  expect(periods).toHaveLength(1);
  expect(periods[0]?.granted_amount).toBe("25.000000");
  const funding = (await import("../../lib/services/subscription-funding"))
    .subscriptionFundingService;
  const reservation = await funding.reserve({
    organizationId: fixture.source.organization_id,
    logicalOperationId: `renewal-test:${randomUUID()}`,
    operation: "ai_inference",
    amount: "1.000000",
    description: "renewal proof",
    reservationTtlMs: 60000,
  });
  expect(reservation.reservation.requested_amount).toBe("1.000000");
  expect((await rows("subscription_allowance_periods"))[0]?.reserved_amount).toBe("1.000000");
  await funding.settle({
    organizationId: fixture.source.organization_id,
    logicalOperationId: reservation.reservation.logical_operation_id,
    operation: "ai_inference",
    actualAmount: "1.000000",
    occurredAt: new Date(),
  });
  expect((await rows("subscription_allowance_periods"))[0]?.settled_amount).toBe("1.000000");
  const before = await state();
  expect(await queue.processStripeEvent(delivery())).toBe("ack");
  expect(await state()).toEqual(before);
  const count = reads;
  expect(await queue.processStripeEvent(event)).toBe("ack");
  expect(reads).toBe(count);
});
for (const invalid of ["partial", "refund", "oob", "proration", "wrongcustomer", "future"] as const)
  test(`unsupported ${invalid} cannot grant`, async () => {
    await seed();
    if (invalid === "partial") fixture.charge.amount_captured = 2999;
    if (invalid === "refund") fixture.charge.amount_refunded = 1;
    if (invalid === "oob") fixture.invoice.paid_out_of_band = true;
    if (invalid === "proration") fixture.invoice.lines.data[0]!.proration = true;
    if (invalid === "wrongcustomer") fixture.paymentIntent.customer = "cus_wrong";
    if (invalid === "future")
      fixture.invoice.lines.data[0]!.period.start = Math.floor(Date.now() / 1000) + 1000;
    const before = await state();
    expect(await queue.processStripeEvent(delivery())).toBe("retry");
    expect(await state()).toEqual(before);
    expect((await rows("billing_subscription_incidents")).length).toBe(1);
  });
test("deletion during provider retrieval prevents publication", async () => {
  await seed();
  afterRead = async () => {
    await client
      .getPgliteClientForTests()
      .query("UPDATE organizations SET paid_work_fenced_at=clock_timestamp() WHERE id=$1", [
        fixture.source.organization_id,
      ]);
  };
  const before = await state();
  expect(await queue.processStripeEvent(delivery())).toBe("retry");
  expect(await state()).toEqual(before);
});
test("grant failure rolls source and generation back", async () => {
  await seed();
  await client
    .getPgliteClientForTests()
    .exec(
      "CREATE FUNCTION reject_renewal_grant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected grant failure'; END $$; CREATE TRIGGER reject_renewal_grant BEFORE INSERT ON subscription_allowance_transactions FOR EACH ROW EXECUTE FUNCTION reject_renewal_grant();",
    );
  try {
    const before = await state();
    expect(await queue.processStripeEvent(delivery())).toBe("retry");
    expect(await state()).toEqual(before);
  } finally {
    await client
      .getPgliteClientForTests()
      .exec(
        "DROP TRIGGER reject_renewal_grant ON subscription_allowance_transactions; DROP FUNCTION reject_renewal_grant();",
      );
  }
});

async function reserveOne(logicalOperationId = `renewal-test:${randomUUID()}`) {
  return (
    await import("../../lib/services/subscription-funding")
  ).subscriptionFundingService.reserve({
    organizationId: fixture.source.organization_id,
    logicalOperationId,
    operation: "ai_inference",
    amount: "1.000000",
    description: "funding continuity",
    reservationTtlMs: 60000,
  });
}
async function advanceCurrent(
  values: Partial<import("../schemas/billing-subscriptions").BillingSubscription>,
) {
  const { subscriptionAuthorityRepository } = await import("./subscription-authority");
  const current = await subscriptionAuthorityRepository.findById(
    fixture.source.organization_id,
    fixture.source.id,
  );
  if (!current) throw new Error("source missing");
  const result = await subscriptionAuthorityRepository.advance({
    organizationId: current.organization_id,
    subscriptionId: current.id,
    expectedRevision: current.lifecycle_revision,
    source: "reconciliation",
    observation: "authoritative_provider_retrieval",
    values: {
      ...current,
      last_provider_event_id: null,
      last_provider_event_created_at: null,
      provider_object_digest: randomUUID().replaceAll("-", "").repeat(2),
      ...values,
    },
  });
  const { subscriptionEntitlementsRepository } = await import("./subscription-entitlements");
  const previous = await subscriptionEntitlementsRepository.find(current.organization_id);
  await subscriptionEntitlementsRepository.rebuild({
    organizationId: current.organization_id,
    sourceSubscriptionId: current.id,
    sourceSubscriptionRevision: result.subscription.lifecycle_revision,
    expectedProjectionRevision: previous?.projection_revision ?? null,
  });
}
test("terminal source denies new allowance without cash fallback; pinned reservation still settles and replays", async () => {
  await seed();
  const event = delivery();
  expect(await queue.processStripeEvent(event)).toBe("ack");
  const held = await reserveOne();
  await advanceCurrent({ status: "canceled", canceled_at: new Date(), ended_at: new Date() });
  const before = await state();
  await expect(reserveOne()).rejects.toMatchObject({
    code: "SUBSCRIPTION_FUNDING_AUTHORITY_UNAVAILABLE",
  });
  expect(await state()).toEqual(before);
  expect((await reserveOne(held.reservation.logical_operation_id)).replayed).toBe(true);
  const funding = (await import("../../lib/services/subscription-funding"))
    .subscriptionFundingService;
  await funding.settle({
    organizationId: fixture.source.organization_id,
    logicalOperationId: held.reservation.logical_operation_id,
    operation: "ai_inference",
    actualAmount: "1.000000",
    occurredAt: new Date(),
  });
  expect((await rows("subscription_allowance_periods"))[0]?.settled_amount).toBe("1.000000");
  const count = reads;
  expect(await queue.processStripeEvent(event)).toBe("ack");
  expect(reads).toBe(count);
});
test("same-period cancel and undo revisions retain valid allowance admission", async () => {
  await seed();
  expect(await queue.processStripeEvent(delivery())).toBe("ack");
  await advanceCurrent({ cancel_at_period_end: true, canceled_at: new Date() });
  await reserveOne();
  await advanceCurrent({ cancel_at_period_end: false });
  await reserveOne();
  expect((await rows("subscription_allowance_periods"))[0]?.reserved_amount).toBe("2.000000");
});
test("current source period mismatch cannot consume an earlier bucket", async () => {
  await seed();
  expect(await queue.processStripeEvent(delivery())).toBe("ack");
  await advanceCurrent({
    current_period_start: new Date((fixture.subscription.current_period_start + 1) * 1000),
  });
  const before = await state();
  await expect(reserveOne()).rejects.toMatchObject({
    code: "SUBSCRIPTION_FUNDING_AUTHORITY_UNAVAILABLE",
  });
  expect(await state()).toEqual(before);
});
test("source CAS change during retrieval cannot publish captured observation", async () => {
  await seed();
  afterRead = async () => {
    await advanceCurrent({ provider_object_digest: "b".repeat(64) });
  };
  expect(await queue.processStripeEvent(delivery())).toBe("retry");
  expect(await rows("subscription_allowance_periods")).toEqual([]);
});

test("a different paid invoice for an already granted period cannot increment source or grant", async () => {
  await seed();
  expect(await queue.processStripeEvent(delivery())).toBe("ack");
  const before = await state();
  fixture.invoice.id = `in_${randomUUID().replaceAll("-", "")}`;
  fixture.subscription.latest_invoice = fixture.invoice.id;
  fixture.paymentIntent.invoice = fixture.invoice.id;
  fixture.charge.invoice = fixture.invoice.id;
  expect(await queue.processStripeEvent(delivery())).toBe("retry");
  expect(await state()).toEqual(before);
});
test("late projection failure rolls back the already inserted grant and lifecycle journal", async () => {
  await seed();
  await client
    .getPgliteClientForTests()
    .exec(
      "CREATE FUNCTION reject_renewal_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected projection failure'; END $$; CREATE TRIGGER reject_renewal_projection BEFORE UPDATE ON organization_entitlements FOR EACH ROW EXECUTE FUNCTION reject_renewal_projection();",
    );
  try {
    const before = await state();
    expect(await queue.processStripeEvent(delivery())).toBe("retry");
    expect(await state()).toEqual(before);
    expect(
      (await rows("billing_subscription_event_receipts")).some((row) => row.status === "applied"),
    ).toBe(false);
  } finally {
    await client
      .getPgliteClientForTests()
      .exec(
        "DROP TRIGGER reject_renewal_projection ON organization_entitlements; DROP FUNCTION reject_renewal_projection();",
      );
  }
});
test("purchased-only replay preserves explicit expiry and rejects invalid TTL without another debit", async () => {
  await seed();
  const { writeTransaction } = await import("../helpers");
  const { subscriptionFundingReservationsRepository, microsToMoney } = await import(
    "./subscription-funding-reservations"
  );
  const funding = (await import("../../lib/services/subscription-funding"))
    .subscriptionFundingService;
  const logicalOperationId = `cash-replay:${randomUUID()}`,
    creditId = randomUUID(),
    expiresAt = new Date(Date.now() + 60000);
  const digest = createHash("sha256")
    .update(
      ["reserve", fixture.source.organization_id, logicalOperationId, "domain", "1.000000"].join(
        "\u001f",
      ),
    )
    .digest("hex");
  await client
    .getPgliteClientForTests()
    .query(
      "INSERT INTO credit_transactions(id,organization_id,amount,type) VALUES($1,$2,-1,'usage')",
      [creditId, fixture.source.organization_id],
    );
  await writeTransaction((tx) =>
    subscriptionFundingReservationsRepository.createPrerequisite(tx, {
      organizationId: fixture.source.organization_id,
      logicalOperationId,
      requestDigest: digest,
      fundingClass: "cash_only",
      requestedAmount: microsToMoney(1000000n),
      allowanceAmount: microsToMoney(0n),
      purchasedCreditAmount: microsToMoney(1000000n),
      purchasedCreditReservationTransactionId: creditId,
      allowancePeriodId: null,
      expiresAt,
    }),
  );
  const input = {
    organizationId: fixture.source.organization_id,
    logicalOperationId,
    operation: "domain" as const,
    amount: "1.000000",
    description: "historical cash reservation",
  };
  const before = await state();
  expect((await funding.reserve({ ...input, expiresAt })).replayed).toBe(true);
  await expect(
    funding.reserve({ ...input, expiresAt: new Date(expiresAt.getTime() + 1) }),
  ).rejects.toMatchObject({ code: "SUBSCRIPTION_FUNDING_REPLAY_CONFLICT" });
  await expect(funding.reserve({ ...input, reservationTtlMs: -1 })).rejects.toMatchObject({
    code: "SUBSCRIPTION_FUNDING_INVALID_AMOUNT",
  });
  expect(
    (await funding.reserve({ ...input, reservationTtlMs: 1000 })).reservation.expires_at,
  ).toEqual(expiresAt);
  expect(await state()).toEqual(before);
});
test("next renewal never receives an expired old-period reservation refund", async () => {
  await seed();
  const boundary = Math.floor(Date.now() / 1000) + 2;
  fixture.subscription.current_period_end = boundary;
  fixture.invoice.lines.data[0]!.period.end = boundary;
  const firstEvent = delivery();
  expect(await queue.processStripeEvent(firstEvent)).toBe("ack");
  const held = await reserveOne();
  const oldPeriod = (await rows("subscription_allowance_periods"))[0]!;
  await Bun.sleep(Math.max(0, boundary * 1000 - Date.now() + 25));
  const suffix = randomUUID().replaceAll("-", "");
  fixture.invoice.id = `in_${suffix}`;
  fixture.invoice.payment_intent = `pi_${suffix}`;
  fixture.invoice.charge = `ch_${suffix}`;
  fixture.invoice.lines.data[0]!.id = `il_${suffix}`;
  fixture.invoice.lines.data[0]!.period = { start: boundary, end: boundary + 30 * 86400 };
  fixture.invoice.status_transitions.paid_at = boundary;
  fixture.subscription.current_period_start = boundary;
  fixture.subscription.current_period_end = boundary + 30 * 86400;
  fixture.subscription.latest_invoice = fixture.invoice.id;
  fixture.paymentIntent.id = fixture.invoice.payment_intent;
  fixture.paymentIntent.invoice = fixture.invoice.id;
  fixture.paymentIntent.latest_charge = fixture.invoice.charge;
  fixture.charge.id = fixture.invoice.charge;
  fixture.charge.invoice = fixture.invoice.id;
  fixture.charge.payment_intent = fixture.invoice.payment_intent;
  expect(await queue.processStripeEvent(delivery())).toBe("ack");
  const funding = (await import("../../lib/services/subscription-funding"))
    .subscriptionFundingService;
  await funding.settle({
    organizationId: fixture.source.organization_id,
    logicalOperationId: held.reservation.logical_operation_id,
    operation: "ai_inference",
    actualAmount: "0.500000",
    occurredAt: new Date(),
  });
  const periods = await rows("subscription_allowance_periods"),
    old = periods.find((p) => p.id === oldPeriod.id),
    fresh = periods.find((p) => p.id !== oldPeriod.id);
  expect(old?.settled_amount).toBe("0.500000");
  expect(old?.expired_amount).toBe("0.500000");
  expect(fresh?.available_amount).toBe("25.000000");
  const before = await state(),
    count = reads;
  expect(await queue.processStripeEvent(firstEvent)).toBe("ack");
  expect(reads).toBe(count);
  expect(await state()).toEqual(before);
});
async function replaceCurrentSubscription(currentPeriod: boolean) {
  const { subscriptionAuthorityRepository } = await import("./subscription-authority");
  const { subscriptionEntitlementsRepository } = await import("./subscription-entitlements");
  const original = fixture.source;
  await advanceCurrent({ status: "canceled", canceled_at: new Date(), ended_at: new Date() });
  const id = randomUUID(),
    suffix = id.replaceAll("-", "");
  const replacement = await subscriptionAuthorityRepository.create(
    {
      ...original,
      id,
      stripe_subscription_id: `sub_${suffix}`,
      stripe_subscription_item_id: `si_${suffix}`,
      last_provider_event_id: null,
      last_provider_event_created_at: null,
      ...(currentPeriod
        ? {
            current_period_start: new Date(fixture.subscription.current_period_start * 1000),
            current_period_end: new Date(fixture.subscription.current_period_end * 1000),
          }
        : {}),
    },
    "checkout",
    original.id,
  );
  const previous = await subscriptionEntitlementsRepository.find(original.organization_id);
  await subscriptionEntitlementsRepository.rebuild({
    organizationId: original.organization_id,
    sourceSubscriptionId: id,
    sourceSubscriptionRevision: 1,
    expectedProjectionRevision: previous?.projection_revision ?? null,
  });
  fixture.source = replacement.subscription;
  fixture.subscription.id = replacement.subscription.stripe_subscription_id;
  fixture.subscription.items.data[0]!.id = replacement.subscription.stripe_subscription_item_id;
  fixture.invoice.subscription = replacement.subscription.stripe_subscription_id;
  fixture.invoice.lines.data[0]!.subscription = replacement.subscription.stripe_subscription_id;
  fixture.invoice.lines.data[0]!.subscription_item =
    replacement.subscription.stripe_subscription_item_id;
  fixture.invoice.id = `in_${suffix}`;
  fixture.subscription.latest_invoice = fixture.invoice.id;
  fixture.invoice.payment_intent = `pi_${suffix}`;
  fixture.invoice.charge = `ch_${suffix}`;
  fixture.paymentIntent.id = fixture.invoice.payment_intent;
  fixture.paymentIntent.invoice = fixture.invoice.id;
  fixture.paymentIntent.latest_charge = fixture.invoice.charge;
  fixture.charge.id = fixture.invoice.charge;
  fixture.charge.invoice = fixture.invoice.id;
  fixture.charge.payment_intent = fixture.invoice.payment_intent;
}
test("replacement source cannot spend the prior subscription's unexpired allowance", async () => {
  await seed();
  expect(await queue.processStripeEvent(delivery())).toBe("ack");
  await replaceCurrentSubscription(true);
  const before = await state();
  await expect(reserveOne()).rejects.toMatchObject({
    code: "SUBSCRIPTION_FUNDING_AUTHORITY_UNAVAILABLE",
  });
  expect(await state()).toEqual(before);
});
test("new renewal refuses overlapping open allowance belonging to a replaced source", async () => {
  await seed();
  expect(await queue.processStripeEvent(delivery())).toBe("ack");
  await replaceCurrentSubscription(false);
  const before = await state();
  expect(await queue.processStripeEvent(delivery())).toBe("retry");
  expect(await state()).toEqual(before);
});
