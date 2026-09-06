/** Exercises the actual Stripe queue consumer and primary lifecycle finalizer on PGlite with only Stripe retrieval controlled at the external boundary. */

import { afterAll, beforeAll, beforeEach, expect, mock, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { installOrganizationPolicyTestSchema } from "./organization-policy-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
setDefaultTimeout(120_000);
const fixtureNow = new Date();
const EVENT_SECONDS = Math.floor(Date.now() / 1000) - 60;
const PERIOD_START = new Date(Date.UTC(fixtureNow.getUTCFullYear(), fixtureNow.getUTCMonth(), 1));
const PERIOD_END = new Date(Date.UTC(fixtureNow.getUTCFullYear(), fixtureNow.getUTCMonth() + 1, 1));
const ORG_A = "51000000-0000-4000-8000-000000000001";
const ORG_B = "51000000-0000-4000-8000-000000000002";
const USER = "52000000-0000-4000-8000-000000000001";
const SUB_A = "53000000-0000-4000-8000-000000000001";
const SUB_B = "53000000-0000-4000-8000-000000000002";
const DIGEST_A = "a".repeat(64);
let retrieve: (id: string) => Promise<object> = async () => providerSubscription();
mock.module("../../lib/stripe", () => ({
  requireStripe: () => ({ subscriptions: { retrieve: (id: string) => retrieve(id) } }),
}));
let processStripeEvent: typeof import("../../../../api/src/queue/stripe-event").processStripeEvent;
let isSubscriptionFundedOrganization: typeof import("../../lib/services/ai-billing").isSubscriptionFundedOrganization;
let client: typeof import("../client");
let entitlements: import("./subscription-entitlements").SubscriptionEntitlementsRepository;
let authority: import("./subscription-authority").SubscriptionAuthorityRepository;
let operations: import("./subscription-billing-operations").SubscriptionBillingOperationsRepository;
function getPgliteClientForTests() {
  return client.getPgliteClientForTests();
}
beforeAll(async () => {
  ({ processStripeEvent } = await import("../../../../api/src/queue/stripe-event"));
  process.env.STRIPE_SECRET_KEY = "sk_test_terminalfixture";
  process.env.ENVIRONMENT = "local";
  process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
  process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
  process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro";
  process.env.STRIPE_PRO_PRODUCT_ID = "prod_pro";
  client = await import("../client");
  ({ isSubscriptionFundedOrganization } = await import("../../lib/services/ai-billing"));
  ({ subscriptionEntitlementsRepository: entitlements } = await import(
    "./subscription-entitlements"
  ));
  ({ subscriptionAuthorityRepository: authority } = await import("./subscription-authority"));
  ({ subscriptionBillingOperationsRepository: operations } = await import(
    "./subscription-billing-operations"
  ));
  await getPgliteClientForTests().exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY, account_lifecycle_state text NOT NULL DEFAULT 'active', paid_work_fenced_at timestamptz, stripe_customer_id text);
    CREATE TABLE users (id uuid PRIMARY KEY);
    CREATE TABLE credit_transactions (id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), CONSTRAINT credit_transactions_id_org_idx UNIQUE (id, organization_id));
  `);
  await installOrganizationPolicyTestSchema((query) => getPgliteClientForTests().exec(query));
  const noticeMigration = await readFile(
    new URL("../migrations/0382_subscription_notice_intents.sql", import.meta.url),
    "utf8",
  );
  for (const statement of noticeMigration.split("--> statement-breakpoint")) {
    if (statement.trim()) await getPgliteClientForTests().exec(statement);
  }
});
beforeEach(async () => {
  retrieve = async () => providerSubscription();
  await getPgliteClientForTests().exec(`
    ALTER TABLE billing_subscription_revisions DISABLE TRIGGER billing_subscription_revisions_immutable_guard;
    ALTER TABLE subscription_allowance_transactions DISABLE TRIGGER subscription_allowance_transactions_immutable_guard;
    TRUNCATE TABLE billing_subscriptions, users, organizations CASCADE;
    ALTER TABLE billing_subscription_revisions ENABLE TRIGGER billing_subscription_revisions_immutable_guard;
    ALTER TABLE subscription_allowance_transactions ENABLE TRIGGER subscription_allowance_transactions_immutable_guard;
    INSERT INTO organizations (id, stripe_customer_id) VALUES ('${ORG_A}', 'cus_repoa'), ('${ORG_B}', 'cus_repob');
    INSERT INTO users (id) VALUES ('${USER}');
    INSERT INTO billing_subscriptions (
      id, organization_id, provider_environment, stripe_customer_id,
      stripe_subscription_id, stripe_subscription_item_id,
      plan_key, catalog_version, status, current_period_start, current_period_end,
      lifecycle_revision, provider_object_digest
    ) VALUES
      ('${SUB_A}', '${ORG_A}', 'test', 'cus_repoa', 'sub_repoa', 'si_repoa', 'plus_monthly', 'v1', 'active',
       '${PERIOD_START.toISOString()}', '${PERIOD_END.toISOString()}', 1, '${DIGEST_A}'),
      ('${SUB_B}', '${ORG_B}', 'test', 'cus_repob', 'sub_repob', 'si_repob', 'plus_monthly', 'v1', 'active',
       '${PERIOD_START.toISOString()}', '${PERIOD_END.toISOString()}', 1, '${DIGEST_A}');
    INSERT INTO billing_subscription_revisions (
      organization_id, subscription_id, revision, source, provider_environment,
      stripe_customer_id, stripe_subscription_id,
      stripe_subscription_item_id, plan_key, catalog_version, status,
      current_period_start, current_period_end, cancel_at_period_end,
      provider_object_digest
    ) VALUES ('${ORG_A}', '${SUB_A}', 1, 'webhook', 'test', 'cus_repoa', 'sub_repoa', 'si_repoa',
      'plus_monthly', 'v1', 'active', '${PERIOD_START.toISOString()}',
      '${PERIOD_END.toISOString()}', false, '${DIGEST_A}');
    UPDATE organization_subscription_authorities SET subscription_id = '${SUB_A}', state = 'current' WHERE organization_id = '${ORG_A}';
    UPDATE organization_subscription_authorities SET subscription_id = '${SUB_B}', state = 'current' WHERE organization_id = '${ORG_B}';
  `);
});

afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
});

function providerSubscription() {
  return {
    id: "sub_repoa",
    object: "subscription",
    livemode: false,
    customer: "cus_repoa",
    status: "canceled",
    current_period_start: PERIOD_START.getTime() / 1000,
    current_period_end: PERIOD_END.getTime() / 1000,
    cancel_at_period_end: false,
    canceled_at: EVENT_SECONDS,
    ended_at: EVENT_SECONDS,
    on_behalf_of: null,
    transfer_data: null,
    application_fee_percent: null,
    schedule: null,
    pending_update: null,
    pause_collection: null,
    items: {
      has_more: false,
      data: [
        {
          id: "si_repoa",
          object: "subscription_item",
          quantity: 1,
          price: {
            id: "price_plus",
            product: "prod_plus",
            livemode: false,
            currency: "usd",
            unit_amount: 3000,
            type: "recurring",
            billing_scheme: "per_unit",
            transform_quantity: null,
            recurring: {
              interval: "month",
              interval_count: 1,
              usage_type: "licensed",
              trial_period_days: null,
            },
          },
        },
      ],
    },
  };
}
function delivery(id = "evt_terminal", created = EVENT_SECONDS) {
  const event: import("stripe").default.CustomerSubscriptionUpdatedEvent = JSON.parse(
    JSON.stringify({
      id,
      object: "event",
      type: "customer.subscription.updated",
      livemode: false,
      created,
      data: {
        object: {
          id: "sub_repoa",
          object: "subscription",
          status: "active",
          metadata: { credits: "999", organization_id: ORG_B },
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
async function rows(table: string) {
  return (await getPgliteClientForTests().query(`SELECT * FROM ${table}`)).rows;
}
test("actual consumer ignores stale payload fields and atomically publishes retrieved terminal state once", async () => {
  expect(await processStripeEvent(delivery())).toBe("ack");
  expect(await authority.findById(ORG_A, SUB_A)).toMatchObject({
    status: "canceled",
    lifecycle_revision: 2,
  });
  expect(await entitlements.find(ORG_A)).toMatchObject({
    plan_key: "free",
    source_subscription_revision: 2,
  });
  expect(await rows("billing_subscription_event_receipts")).toEqual([
    expect.objectContaining({ status: "applied", disposition: "terminal_lifecycle_finalized" }),
  ]);
  expect(await rows("credit_transactions")).toHaveLength(0);
  expect(await isSubscriptionFundedOrganization(ORG_A)).toBe(false);
  expect(await processStripeEvent(delivery())).toBe("ack");
  expect(await authority.listRevisions(ORG_A, SUB_A)).toHaveLength(2);
});
test("historical applied replay acknowledges its exact receipt without retrieving or changing current authority", async () => {
  const first = delivery("evt_first");
  const newer = delivery("evt_second", EVENT_SECONDS + 1);
  expect(await processStripeEvent(first)).toBe("ack");
  expect(await processStripeEvent(newer)).toBe("ack");
  const current = await authority.findById(ORG_A, SUB_A);
  const projection = await entitlements.find(ORG_A);
  expect(current).toMatchObject({
    lifecycle_revision: 3,
    last_provider_event_id: "evt_second",
    status: "canceled",
  });
  expect(projection).toMatchObject({ plan_key: "free", source_subscription_revision: 3 });
  const revisions = await authority.listRevisions(ORG_A, SUB_A);
  const policyAudit = await rows("organization_policy_audit");
  const notices = await rows("subscription_notice_intents");
  const association = await rows("organization_subscription_authorities");
  let requests = 0;
  retrieve = async () => {
    requests += 1;
    throw new Error("Replay must not retrieve Stripe");
  };
  expect(await processStripeEvent(first)).toBe("ack");
  expect(requests).toBe(0);
  expect(await authority.findById(ORG_A, SUB_A)).toEqual(current);
  expect(await entitlements.find(ORG_A)).toEqual(projection);
  expect(await authority.listRevisions(ORG_A, SUB_A)).toEqual(revisions);
  expect(await rows("organization_policy_audit")).toEqual(policyAudit);
  expect(await rows("subscription_notice_intents")).toEqual(notices);
  expect(await rows("organization_subscription_authorities")).toEqual(association);
  expect(await isSubscriptionFundedOrganization(ORG_A)).toBe(false);
  const altered = delivery("evt_first");
  altered.body.event.data.object.metadata = { credits: "123" };
  expect(await processStripeEvent(altered)).toBe("retry");
  expect(await processStripeEvent(delivery("evt_unseenold"))).toBe("retry");
  expect(requests).toBe(0);
  expect(await authority.findById(ORG_A, SUB_A)).toEqual(current);
  expect(await entitlements.find(ORG_A)).toEqual(projection);
  expect(await rows("billing_subscription_event_receipts")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ provider_event_id: "evt_first", status: "applied" }),
      expect.objectContaining({ provider_event_id: "evt_second", status: "applied" }),
      expect.objectContaining({
        provider_event_id: "evt_unseenold",
        status: "received",
        lease_token: null,
      }),
    ]),
  );
});
test("provider failures release the receipt for retry without publication", async () => {
  retrieve = async () => {
    throw new Error("Invalid request: subscription not found");
  };
  expect(await processStripeEvent(delivery())).toBe("retry");
  expect(await rows("billing_subscription_event_receipts")).toEqual([
    expect.objectContaining({ status: "received", lease_token: null }),
  ]);
  expect(await entitlements.find(ORG_A)).toMatchObject({
    projection_revision: 0,
    source_subscription_id: null,
  });
  retrieve = async () => providerSubscription();
  expect(await processStripeEvent(delivery())).toBe("ack");
});
test("unsupported provider observations, merchant context and identity drift never publish", async () => {
  const wrongPrice = providerSubscription();
  wrongPrice.items.data[0]!.price.id = "price_other";
  const wrongProduct = providerSubscription();
  wrongProduct.items.data[0]!.price.product = "prod_other";
  const wrongItem = providerSubscription();
  wrongItem.items.data[0]!.id = "si_other";
  const variants = [
    wrongPrice,
    wrongProduct,
    wrongItem,
    { ...providerSubscription(), customer: "cus_other" },
    { ...providerSubscription(), status: "active" },
    { ...providerSubscription(), livemode: true },
    { ...providerSubscription(), on_behalf_of: "acct_other" },
    { ...providerSubscription(), current_period_end: (PERIOD_END.getTime() + 86_400_000) / 1000 },
    { ...providerSubscription(), items: { has_more: true, data: [] } },
  ];
  for (const [index, value] of variants.entries()) {
    retrieve = async () => value;
    expect(await processStripeEvent(delivery(`evt_variant${index}`))).toBe("retry");
  }
  const connected = delivery("evt_connected");
  connected.body.event.account = "acct_other";
  expect(await processStripeEvent(connected)).toBe("retry");
  expect(await entitlements.find(ORG_A)).toMatchObject({
    projection_revision: 0,
    source_subscription_id: null,
  });
  expect(await authority.findById(ORG_A, SUB_A)).toMatchObject({
    status: "active",
    lifecycle_revision: 1,
  });
});
test("unknown subscriptions and missing server catalog authority retry without provider trust", async () => {
  const unknown = delivery("evt_unknown");
  unknown.body.event.data.object.id = "sub_unknown";
  expect(await processStripeEvent(unknown)).toBe("retry");
  expect(await rows("billing_subscription_event_receipts")).toHaveLength(0);
  delete process.env.STRIPE_PLUS_MONTHLY_PRICE_ID;
  try {
    expect(await processStripeEvent(delivery())).toBe("retry");
    expect(await authority.findById(ORG_A, SUB_A)).toMatchObject({ lifecycle_revision: 1 });
  } finally {
    process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
  }
});
test("an expired retrieval lease cannot publish or release a successor lease", async () => {
  retrieve = async () => {
    await getPgliteClientForTests().exec(
      "UPDATE billing_subscription_event_receipts SET lease_expires_at=clock_timestamp()-interval '1 second'",
    );
    const receipt = (await rows("billing_subscription_event_receipts"))[0] as { id: string };
    await operations.claimEvent({
      organizationId: ORG_A,
      receiptId: receipt.id,
      leaseToken: "55000000-0000-4000-8000-000000000099",
      leaseDurationMs: 60000,
    });
    return providerSubscription();
  };
  expect(await processStripeEvent(delivery())).toBe("retry");
  expect(await entitlements.find(ORG_A)).toMatchObject({
    projection_revision: 0,
    source_subscription_id: null,
  });
  expect(await rows("billing_subscription_event_receipts")).toEqual([
    expect.objectContaining({
      status: "processing",
      lease_token: "55000000-0000-4000-8000-000000000099",
    }),
  ]);
});
test("reverse retrieval completion rejects the stale CAS then re-observes without restoring admission", async () => {
  let unblock: (value: object) => void = () => {
    throw new Error("Retrieval has not started");
  };
  let started: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  retrieve = async () =>
    new Promise<object>((resolve) => {
      unblock = resolve;
      started();
    });
  const older = processStripeEvent(delivery("evt_older"));
  await waiting;
  retrieve = async () => providerSubscription();
  expect(await processStripeEvent(delivery("evt_newer", EVENT_SECONDS + 1))).toBe("ack");
  unblock(providerSubscription());
  expect(await older).toBe("retry");
  expect(await entitlements.find(ORG_A)).toMatchObject({
    plan_key: "free",
    source_subscription_revision: 2,
  });
  expect(await processStripeEvent(delivery("evt_older"))).toBe("retry");
  expect(await authority.findById(ORG_A, SUB_A)).toMatchObject({
    status: "canceled",
    lifecycle_revision: 2,
  });
  expect(await isSubscriptionFundedOrganization(ORG_A)).toBe(false);
});
