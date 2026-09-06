/** Exercises authenticated-command domain publication through the actual Stripe queue and migrated primary finalizer with only provider transport controlled. */
import { afterAll, beforeAll, expect, mock, setDefaultTimeout, test } from "bun:test";
import {
  installCancellationTestSchema,
  seedCancellationTestAccount,
} from "./subscription-cancellation-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.ENVIRONMENT = "local";
process.env.STRIPE_SECRET_KEY = "sk_test_cancellationfixture";
process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro";
process.env.STRIPE_PRO_PRODUCT_ID = "prod_pro";
setDefaultTimeout(120000);
let fixture: Awaited<ReturnType<typeof seedCancellationTestAccount>>;
let providerOverride: object | null = null;
let customerDeleted = false;
let reads = 0,
  updates = 0;
let afterRead: (() => Promise<void>) | null = null;
mock.module("../../lib/stripe", () => ({
  requireStripe: () => ({
    customers: {
      retrieve: async (id: string) => ({
        id,
        object: "customer",
        livemode: false,
        deleted: customerDeleted,
      }),
    },
    subscriptions: {
      retrieve: async () => {
        reads++;
        const value = structuredClone(providerOverride ?? fixture.provider);
        if (afterRead) {
          const action = afterRead;
          afterRead = null;
          await action();
        }
        return value;
      },
      update: async () => {
        updates++;
        fixture.provider.cancel_at_period_end = true;
        fixture.provider.cancel_at = fixture.provider.current_period_end;
        fixture.provider.canceled_at = Math.floor(Date.now() / 1000);
        return structuredClone(fixture.provider);
      },
    },
  }),
}));
let client: typeof import("../client");
let service: typeof import("../../lib/services/subscription-cancellation");
let queue: typeof import("../../../../api/src/queue/stripe-event");
beforeAll(async () => {
  client = await import("../client");
  await installCancellationTestSchema((query) => client.getPgliteClientForTests().exec(query));
  service = await import("../../lib/services/subscription-cancellation");
  queue = await import("../../../../api/src/queue/stripe-event");
});
afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
});
async function seed(applied = true) {
  fixture = await seedCancellationTestAccount();
  providerOverride = null;
  customerDeleted = false;
  reads = 0;
  updates = 0;
  afterRead = null;
  if (applied)
    expect(
      (await service.submitOrganizationSubscriptionCancellation(fixture.input, async () => {}))
        .status,
    ).toBe("APPLIED");
}
function delivery(id: string, created = Math.floor(Date.now() / 1000)) {
  const event: import("stripe").default.CustomerSubscriptionUpdatedEvent = JSON.parse(
    JSON.stringify({
      id,
      object: "event",
      type: "customer.subscription.updated",
      livemode: false,
      created,
      data: {
        object: {
          id: fixture.source.stripe_subscription_id,
          object: "subscription",
          status: "active",
          cancel_at_period_end: true,
        },
      },
    }),
  );
  return {
    body: {
      kind: "stripe.event" as const,
      eventId: id,
      eventType: event.type,
      event,
      receivedAt: Date.now(),
    },
    attempts: 1,
  };
}
interface PublicationRow {
  lifecycle_revision: number;
  status: string;
  cancel_at_period_end: boolean;
  last_provider_event_id: string | null;
  source_subscription_revision: number;
  projection_revision: number;
  policy_generation: number;
  notices: number;
}
async function state() {
  return (
    await client
      .getPgliteClientForTests()
      .query<PublicationRow>(
        `SELECT s.lifecycle_revision,s.status,s.cancel_at_period_end,s.last_provider_event_id,e.source_subscription_revision,e.projection_revision,a.policy_generation,(SELECT count(*)::int FROM subscription_notice_intents WHERE organization_id=s.organization_id) notices FROM billing_subscriptions s JOIN organization_entitlements e ON e.organization_id=s.organization_id JOIN organization_subscription_authorities a ON a.organization_id=s.organization_id WHERE s.id=$1`,
        [fixture.input.subscriptionId],
      )
  ).rows;
}
test("actual command then queue event advances once; exact historical replay and unseen late event never roll back", async () => {
  await seed();
  const created = Math.floor(Date.now() / 1000);
  const first = delivery("evt_scheduled1", created);
  expect(await queue.processStripeEvent(first)).toBe("ack");
  expect((await state())[0]).toMatchObject({
    lifecycle_revision: 3,
    source_subscription_revision: 3,
    status: "active",
    cancel_at_period_end: true,
    notices: 0,
  });
  expect(await queue.processStripeEvent(delivery("evt_scheduled2", created + 1))).toBe("ack");
  const current = await state();
  const calls = reads;
  expect(await queue.processStripeEvent(first)).toBe("ack");
  expect(reads).toBe(calls);
  expect(await state()).toEqual(current);
  expect(await queue.processStripeEvent(delivery("evt_unseenold", created - 1))).toBe("retry");
  expect(await state()).toEqual(current);
  expect(updates).toBe(1);
  const altered = structuredClone(first);
  altered.body.event.data.object.metadata = { changed: "yes" };
  expect(await queue.processStripeEvent(altered)).toBe("retry");
  expect(await state()).toEqual(current);
});
test("uncommanded active provider scheduling remains retained", async () => {
  await seed(false);
  fixture.provider.cancel_at_period_end = true;
  fixture.provider.cancel_at = fixture.provider.current_period_end;
  fixture.provider.canceled_at = Math.floor(Date.now() / 1000);
  const before = await state();
  expect(await queue.processStripeEvent(delivery("evt_uncommanded"))).toBe("retry");
  expect(await state()).toEqual(before);
});
test("projection conflict rolls back source journal generation and receipt publication", async () => {
  await seed();
  const before = await state();
  afterRead = async () => {
    await client
      .getPgliteClientForTests()
      .query(
        "UPDATE organization_entitlements SET projection_revision=projection_revision+1 WHERE organization_id=$1",
        [fixture.input.organizationId],
      );
  };
  expect(await queue.processStripeEvent(delivery("evt_conflicted"))).toBe("retry");
  const after = await state();
  expect(after[0]).toMatchObject({
    lifecycle_revision: 2,
    source_subscription_revision: 2,
    policy_generation: before[0]!.policy_generation,
    notices: 0,
  });
  expect(
    (
      await client
        .getPgliteClientForTests()
        .query(
          "SELECT status FROM billing_subscription_event_receipts WHERE provider_event_id='evt_conflicted'",
        )
    ).rows,
  ).toEqual([{ status: "received" }]);
});
test("provider schedule drift cannot rewrite the applied command result", async () => {
  await seed();
  const before = await state();
  fixture.provider.canceled_at!--;
  expect(await queue.processStripeEvent(delivery("evt_drift"))).toBe("retry");
  expect(await state()).toEqual(before);
});

test("stale active payload delegates canonical terminal state and historical scheduled replay remains exact", async () => {
  await seed();
  const first = delivery("evt_beforeterminal");
  expect(await queue.processStripeEvent(first)).toBe("ack");
  providerOverride = {
    ...fixture.provider,
    status: "canceled",
    ended_at: Math.floor(Date.now() / 1000),
  };
  expect(
    await queue.processStripeEvent(delivery("evt_afterterminal", first.body.event.created + 1)),
  ).toBe("ack");
  const terminal = await state();
  expect(terminal[0]).toMatchObject({ status: "canceled", notices: 1 });
  const count = reads;
  expect(await queue.processStripeEvent(first)).toBe("ack");
  expect(reads).toBe(count);
  expect(await state()).toEqual(terminal);
});
test("canonical Customer deletion retains an otherwise matching scheduled event", async () => {
  await seed();
  customerDeleted = true;
  const before = await state();
  expect(await queue.processStripeEvent(delivery("evt_deletedcustomer"))).toBe("retry");
  expect(await state()).toEqual(before);
});
test("newer terminal source committed during provider retrieval cannot be overwritten by old active observation", async () => {
  await seed();
  const first = delivery("evt_racingactive");
  afterRead = async () => {
    providerOverride = {
      ...fixture.provider,
      status: "canceled",
      ended_at: Math.floor(Date.now() / 1000),
    };
    const terminal = delivery("evt_racingterminal", first.body.event.created + 1);
    terminal.body.event.data.object.cancel_at_period_end = false;
    expect(await queue.processStripeEvent(terminal)).toBe("ack");
    providerOverride = null;
  };
  expect(await queue.processStripeEvent(first)).toBe("retry");
  expect((await state())[0]).toMatchObject({
    status: "canceled",
    lifecycle_revision: 3,
    source_subscription_revision: 3,
    notices: 1,
  });
});
test("receipt lease lost after lifecycle write rolls back the entire publication", async () => {
  await seed();
  const before = await state();
  await client
    .getPgliteClientForTests()
    .exec(
      `CREATE FUNCTION expire_cancel_event_lease() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.provider_event_id='evt_leaseexpire' THEN UPDATE billing_subscription_event_receipts SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE provider_event_id=NEW.provider_event_id; END IF; RETURN NEW; END $$; CREATE TRIGGER expire_cancel_event_lease AFTER INSERT ON billing_subscription_revisions FOR EACH ROW EXECUTE FUNCTION expire_cancel_event_lease();`,
    );
  try {
    expect(await queue.processStripeEvent(delivery("evt_leaseexpire"))).toBe("retry");
    expect(await state()).toEqual(before);
    expect(
      (
        await client
          .getPgliteClientForTests()
          .query(
            "SELECT count(*)::int AS count FROM billing_subscription_revisions WHERE provider_event_id='evt_leaseexpire'",
          )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(
      (
        await client
          .getPgliteClientForTests()
          .query(
            "SELECT status FROM billing_subscription_event_receipts WHERE provider_event_id='evt_leaseexpire'",
          )
      ).rows,
    ).toEqual([{ status: "received" }]);
  } finally {
    await client
      .getPgliteClientForTests()
      .exec(
        "DROP TRIGGER expire_cancel_event_lease ON billing_subscription_revisions; DROP FUNCTION expire_cancel_event_lease();",
      );
  }
});
