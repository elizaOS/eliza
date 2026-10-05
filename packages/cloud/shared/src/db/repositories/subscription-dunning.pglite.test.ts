/** Exercises dunning, dunning cancellation, unowned subscription deliveries and recovery through migrated PGlite transactions, the real queue consumer and the real Stripe SDK against controlled loopback HTTP; no live provider evidence is claimed. */
import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { installCancellationTestSchema } from "./subscription-cancellation-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.ENVIRONMENT = "local";
process.env.NODE_ENV = "test";
process.env.CLOUD_E2E = "1";
process.env.STRIPE_SECRET_KEY = "sk_test_cloud_e2e";
process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro";
process.env.STRIPE_PRO_PRODUCT_ID = "prod_pro";
setDefaultTimeout(180_000);

const DAY = 86_400;
const GRACE_MS = 3 * DAY * 1000;
let client: typeof import("../client");
let queue: typeof import("../../../../api/src/queue/stripe-event");
let recovery: typeof import("../../lib/services/subscription-reconciliation");
let policy: typeof import("../../lib/services/organization-quota-policy");
/** Provider objects served by the loopback Stripe API, keyed by id. */
const objects = new Map<string, object>();
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  const id = request.url?.split("?")[0]?.split("/").at(-1) ?? "";
  if (request.url?.startsWith("/v1/customers/")) {
    response.end(JSON.stringify({ id, object: "customer", livemode: false }));
    return;
  }
  const object = objects.get(id);
  if (!object) {
    response.writeHead(404);
    response.end(
      JSON.stringify({ error: { type: "invalid_request_error", message: `No such object ${id}` } }),
    );
    return;
  }
  response.end(JSON.stringify(object));
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback address missing");
  process.env.STRIPE_CLOUD_E2E_API_ORIGIN = `http://127.0.0.1:${address.port}`;
  client = await import("../client");
  await installCancellationTestSchema((query) => client.getPgliteClientForTests().exec(query));
  const migration = await readFile(
    new URL("../migrations/0385_subscription_reconciliation.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint"))
    if (statement.trim()) await client.getPgliteClientForTests().exec(statement);
  queue = await import("../../../../api/src/queue/stripe-event");
  recovery = await import("../../lib/services/subscription-reconciliation");
  policy = await import("../../lib/services/organization-quota-policy");
});
beforeEach(async () => {
  // Isolate recovery scans to the account under test.
  await client.getPgliteClientForTests().exec("UPDATE organizations SET is_active=false");
  objects.clear();
});
afterAll(async () => {
  if (server.listening) {
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
            ? reject(error)
            : resolve(),
        ),
      );
  }
  await client.closeDatabaseConnectionsForTests();
});

const query = <T = Record<string, unknown>>(text: string, values: unknown[] = []) =>
  client
    .getPgliteClientForTests()
    .query<T>(text, values)
    .then((result) => result.rows);

/** Seeds an active organization subscription whose stored period is [start, end] seconds from now. */
async function seed(startOffset: number, endOffset: number) {
  const { subscriptionAuthorityRepository } = await import("./subscription-authority");
  const { subscriptionEntitlementsRepository } = await import("./subscription-entitlements");
  const organizationId = randomUUID(),
    userId = randomUUID(),
    subscriptionId = randomUUID();
  const suffix = subscriptionId.replaceAll("-", "");
  const now = Math.floor(Date.now() / 1000);
  const start = now + startOffset,
    end = now + endOffset;
  const source = {
    provider: "stripe" as const,
    provider_environment: "test" as const,
    stripe_customer_id: `cus_${suffix}`,
    stripe_subscription_id: `sub_${suffix}`,
    stripe_subscription_item_id: `si_${suffix}`,
    plan_key: "plus_monthly" as const,
    catalog_version: "v1",
    status: "active" as const,
    current_period_start: new Date(start * 1000),
    current_period_end: new Date(end * 1000),
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
    dunning_started_at: null,
    grace_expires_at: null,
    pending_plan_key: null,
    last_provider_event_id: null,
    last_provider_event_created_at: null,
    provider_object_digest: "a".repeat(64),
  };
  await query("INSERT INTO organizations(id,stripe_customer_id) VALUES($1,$2)", [
    organizationId,
    source.stripe_customer_id,
  ]);
  await query("INSERT INTO users(id,organization_id,role) VALUES($1,$2,'owner')", [
    userId,
    organizationId,
  ]);
  await subscriptionAuthorityRepository.create(
    { ...source, id: subscriptionId, organization_id: organizationId },
    "checkout",
    null,
  );
  await subscriptionEntitlementsRepository.rebuild({
    organizationId,
    sourceSubscriptionId: subscriptionId,
    sourceSubscriptionRevision: 1,
    expectedProjectionRevision: 0,
  });
  const provider = {
    id: source.stripe_subscription_id,
    object: "subscription",
    livemode: false,
    customer: source.stripe_customer_id,
    status: "active",
    current_period_start: start,
    current_period_end: end,
    cancel_at_period_end: false,
    cancel_at: null as number | null,
    canceled_at: null as number | null,
    ended_at: null as number | null,
    trial_start: null,
    trial_end: null,
    on_behalf_of: null,
    transfer_data: null,
    application_fee_percent: null,
    schedule: null,
    pending_update: null,
    pause_collection: null,
    latest_invoice: null as string | null,
    items: {
      has_more: false,
      data: [
        {
          id: source.stripe_subscription_item_id,
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
  await query("UPDATE organizations SET is_active=true WHERE id=$1", [organizationId]);
  return { organizationId, userId, subscriptionId, source, provider, now, start, end };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

function delivery(type: string, object: object, options: { apiVersion?: string } = {}) {
  const id = `evt_${randomUUID().replaceAll("-", "")}`;
  // Stripe subscription deliveries carry the complete provider object, including
  // customer, livemode and latest_invoice used to route original upgrade evidence.
  const providerObject =
    "id" in object && typeof object.id === "string" && type.startsWith("customer.subscription.")
      ? objects.get(object.id)
      : undefined;
  const event = JSON.parse(
    JSON.stringify({
      id,
      object: "event",
      type,
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: { object: { ...providerObject, ...object } },
      api_version: options.apiVersion ?? "2024-11-20.acacia",
      pending_webhooks: 1,
      request: null,
    }),
  );
  return {
    body: {
      kind: "stripe.event" as const,
      eventId: id,
      eventType: type,
      event,
      receivedAt: Date.now(),
    },
    attempts: 1,
  };
}

async function source(f: Seeded) {
  return (
    await query<{
      status: string;
      lifecycle_revision: number;
      dunning_started_at: Date | null;
      grace_expires_at: Date | null;
      current_period_start: Date;
      current_period_end: Date;
    }>(
      "SELECT status,lifecycle_revision,dunning_started_at,grace_expires_at,current_period_start,current_period_end FROM billing_subscriptions WHERE id=$1",
      [f.subscriptionId],
    )
  )[0];
}
async function incidents(f: Seeded) {
  return query<{ kind: string; context: { reason: string; observedBy: string } }>(
    "SELECT kind,context FROM billing_subscription_incidents WHERE organization_id=$1 ORDER BY created_at",
    [f.organizationId],
  );
}
async function receipt(eventId: string) {
  return (
    await query<{ status: string; disposition: string | null }>(
      "SELECT status,disposition FROM billing_subscription_event_receipts WHERE provider_event_id=$1",
      [eventId],
    )
  )[0];
}
/** Stripe advances the period at renewal even when the renewal invoice fails. */
function failedRenewal(f: Seeded, status: "past_due" | "unpaid" | "canceled") {
  const advanced = {
    ...f.provider,
    status,
    current_period_start: f.end,
    current_period_end: f.end + 30 * DAY,
  };
  return status === "canceled" ? { ...advanced, canceled_at: f.now, ended_at: f.now } : advanced;
}

test("renewal grace keeps an active projection paid past its period end, then projects the free tier", async () => {
  const f = await seed(-30 * DAY, -3600);
  const stored = new Date(f.end * 1000);
  const within = await policy.readOrganizationQuotaPolicy(f.organizationId);
  expect(within.subscriptionFunded).toBe(true);
  expect(within.authority.effectiveUntil).toBe(new Date(stored.getTime() + GRACE_MS).toISOString());
  const lapsed = await client.dbWrite.transaction((tx) =>
    policy.readOrganizationQuotaPolicyInTransaction(
      tx,
      f.organizationId,
      new Date(stored.getTime() + GRACE_MS + 1000),
    ),
  );
  expect(lapsed.subscriptionFunded).toBe(false);
  expect(lapsed.tier).toMatchObject({ status: "available", value: { tierName: "free" } });
  expect(lapsed.authority).toMatchObject({
    effectiveFrom: new Date(stored.getTime() + GRACE_MS).toISOString(),
    effectiveUntil: null,
  });
});

test("invoice.payment_failed on a Basil payload publishes dunning grace once, then lapses to free", async () => {
  const f = await seed(-30 * DAY, -3600);
  const invoiceId = `in_${randomUUID().replaceAll("-", "")}`;
  objects.set(f.source.stripe_subscription_id, failedRenewal(f, "past_due"));
  objects.set(invoiceId, {
    id: invoiceId,
    object: "invoice",
    livemode: false,
    subscription: f.source.stripe_subscription_id,
    billing_reason: "subscription_cycle",
    status: "open",
  });
  const input = delivery(
    "invoice.payment_failed",
    {
      id: invoiceId,
      object: "invoice",
      billing_reason: "subscription_cycle",
      parent: {
        type: "subscription_details",
        subscription_details: { subscription: f.source.stripe_subscription_id },
      },
    },
    { apiVersion: "2025-03-31.basil" },
  );
  expect(await queue.processStripeEvent(input)).toBe("ack");
  const dunning = await source(f);
  const due = new Date(f.end * 1000);
  expect(dunning).toMatchObject({
    status: "grace",
    lifecycle_revision: 2,
    dunning_started_at: due,
    grace_expires_at: new Date(due.getTime() + GRACE_MS),
    // The period that came due is retained; paid recovery publishes the next one.
    current_period_start: new Date(f.start * 1000),
    current_period_end: due,
  });
  expect(await receipt(input.body.eventId)).toEqual({
    status: "applied",
    disposition: "dunning_lifecycle_finalized",
  });
  const entitlement = (
    await query<{ state: string; entitlement_effective: boolean; effective_until: Date }>(
      "SELECT state,entitlement_effective,effective_until FROM organization_entitlements WHERE organization_id=$1",
      [f.organizationId],
    )
  )[0];
  expect(entitlement).toEqual({
    state: "grace",
    entitlement_effective: true,
    effective_until: new Date(due.getTime() + GRACE_MS),
  });
  expect((await policy.readOrganizationQuotaPolicy(f.organizationId)).subscriptionFunded).toBe(
    true,
  );
  const afterGrace = await client.dbWrite.transaction((tx) =>
    policy.readOrganizationQuotaPolicyInTransaction(
      tx,
      f.organizationId,
      new Date(due.getTime() + GRACE_MS + 1000),
    ),
  );
  expect(afterGrace.subscriptionFunded).toBe(false);
  expect(afterGrace.tier).toMatchObject({ value: { tierName: "free" } });
  // Replay neither republishes nor retries.
  expect(await queue.processStripeEvent(input)).toBe("ack");
  expect((await source(f))?.lifecycle_revision).toBe(2);
  // A live unpaid update moves the source out of grace.
  objects.set(f.source.stripe_subscription_id, failedRenewal(f, "unpaid"));
  expect(
    await queue.processStripeEvent(
      delivery("customer.subscription.updated", {
        id: f.source.stripe_subscription_id,
        object: "subscription",
        status: "active",
      }),
    ),
  ).toBe("ack");
  expect(await source(f)).toMatchObject({ status: "unpaid", lifecycle_revision: 3 });
  expect((await policy.readOrganizationQuotaPolicy(f.organizationId)).subscriptionFunded).toBe(
    false,
  );
});

test("a subscription Stripe cancels after failed payments publishes terminal with Stripe's period and allows a new checkout", async () => {
  const f = await seed(-30 * DAY, -3600);
  objects.set(f.source.stripe_subscription_id, failedRenewal(f, "past_due"));
  expect(
    await queue.processStripeEvent(
      delivery("customer.subscription.updated", {
        id: f.source.stripe_subscription_id,
        object: "subscription",
        status: "past_due",
      }),
    ),
  ).toBe("ack");
  expect((await source(f))?.status).toBe("grace");
  objects.set(f.source.stripe_subscription_id, failedRenewal(f, "canceled"));
  expect(
    await queue.processStripeEvent(
      delivery("customer.subscription.deleted", {
        id: f.source.stripe_subscription_id,
        object: "subscription",
        status: "canceled",
      }),
    ),
  ).toBe("ack");
  expect(await source(f)).toMatchObject({
    status: "canceled",
    current_period_start: new Date(f.end * 1000),
    current_period_end: new Date((f.end + 30 * DAY) * 1000),
  });
  expect((await policy.readOrganizationQuotaPolicy(f.organizationId)).subscriptionFunded).toBe(
    false,
  );
  const { subscriptionBillingOperationsRepository } = await import(
    "./subscription-billing-operations"
  );
  const checkout = await subscriptionBillingOperationsRepository.enqueueCommand({
    organizationId: f.organizationId,
    subscriptionId: null,
    requestedByUserId: f.userId,
    kind: "checkout",
    targetPlanKey: "plus_monthly",
    expectedSubscriptionRevision: null,
    idempotencyKey: `checkout:${randomUUID()}`,
    providerIdempotencyKey: `provider-checkout-${randomUUID()}`,
    requestDigest: "e".repeat(64),
    now: new Date(),
  });
  expect(checkout.value.status).toBe("PREPARED");
  // A published terminal source no longer occupies recovery slots.
  const { listDueSubscriptionReconciliations } = await import("./subscription-reconciliation");
  expect(await listDueSubscriptionReconciliations(5)).toEqual([]);
});

test("recovery reconciles a missed dunning cancellation instead of degrading forever", async () => {
  const f = await seed(-30 * DAY, -3600);
  objects.set(f.source.stripe_subscription_id, failedRenewal(f, "canceled"));
  const result = await recovery.recoverMissedSubscriptionEvents();
  expect(result).toMatchObject({ status: "ok", attempts: [{ disposition: "applied" }] });
  expect(await source(f)).toMatchObject({
    status: "canceled",
    current_period_end: new Date((f.end + 30 * DAY) * 1000),
  });
});

test("recovery publishes past_due as dunning grace and reports drift per subscription with an incident", async () => {
  const f = await seed(-30 * DAY, -3600);
  objects.set(f.source.stripe_subscription_id, failedRenewal(f, "past_due"));
  expect(await recovery.recoverMissedSubscriptionEvents()).toMatchObject({
    status: "ok",
    attempts: [{ disposition: "applied" }],
  });
  expect(await source(f)).toMatchObject({ status: "grace", lifecycle_revision: 2 });

  const drifted = await seed(-DAY, DAY);
  const swapped = structuredClone(drifted.provider);
  swapped.items.data[0]!.price.id = "price_pro";
  objects.set(drifted.source.stripe_subscription_id, swapped);
  await query("UPDATE organizations SET is_active=false WHERE id=$1", [f.organizationId]);
  const degraded = await recovery.recoverMissedSubscriptionEvents();
  expect(degraded).toMatchObject({
    status: "degraded",
    attempts: [{ disposition: "unsupported" }],
  });
  expect(await incidents(drifted)).toEqual([
    {
      kind: "reconciliation",
      context: {
        reason: "plan_changed_out_of_band",
        observedBy: "reconciliation",
      },
    },
  ]);
  expect((await source(drifted))?.lifecycle_revision).toBe(1);
});

test("renewal, dashboard, plan-swap and unowned subscription deliveries acknowledge instead of retrying", async () => {
  const f = await seed(-DAY, DAY);
  // Renewal: Stripe advanced the period and no local command produced it.
  objects.set(f.source.stripe_subscription_id, {
    ...f.provider,
    current_period_start: f.end,
    current_period_end: f.end + 30 * DAY,
  });
  const renewal = delivery("customer.subscription.updated", {
    id: f.source.stripe_subscription_id,
    object: "subscription",
    status: "active",
  });
  expect(await queue.processStripeEvent(renewal)).toBe("ack");
  expect(await receipt(renewal.body.eventId)).toEqual({
    status: "ignored",
    disposition: "no_owned_change",
  });
  expect(await queue.processStripeEvent(renewal)).toBe("ack");
  expect(await incidents(f)).toEqual([]);

  // Dashboard or portal cancellation that no local command owns.
  objects.set(f.source.stripe_subscription_id, {
    ...f.provider,
    cancel_at_period_end: true,
    cancel_at: f.end,
    canceled_at: f.now,
  });
  const dashboard = delivery("customer.subscription.updated", {
    id: f.source.stripe_subscription_id,
    object: "subscription",
    status: "active",
  });
  expect(await queue.processStripeEvent(dashboard)).toBe("ack");
  // Out-of-band plan change.
  const swapped = structuredClone(f.provider);
  swapped.items.data[0]!.price.id = "price_pro";
  objects.set(f.source.stripe_subscription_id, swapped);
  expect(
    await queue.processStripeEvent(
      delivery("customer.subscription.updated", {
        id: f.source.stripe_subscription_id,
        object: "subscription",
        status: "active",
      }),
    ),
  ).toBe("ack");
  // Types with no lifecycle owner.
  for (const type of [
    "customer.subscription.created",
    "customer.subscription.trial_will_end",
    "customer.subscription.pending_update_applied",
  ])
    expect(
      await queue.processStripeEvent(
        delivery(type, { id: f.source.stripe_subscription_id, object: "subscription" }),
      ),
    ).toBe("ack");
  for (const type of ["invoice.finalized", "invoice.payment_succeeded", "invoice.upcoming"])
    expect(
      await queue.processStripeEvent(
        delivery(type, {
          id: "in_unowned",
          object: "invoice",
          subscription: f.source.stripe_subscription_id,
          billing_reason: "subscription_cycle",
        }),
      ),
    ).toBe("ack");
  expect((await incidents(f)).map((row) => [row.kind, row.context.reason]).sort()).toEqual(
    [
      ["provider_drift", "cancellation_not_owned"],
      ["provider_drift", "pending_update_not_owned"],
      ["provider_drift", "plan_changed_out_of_band"],
      ["provider_drift", "trial_not_supported"],
    ].sort(),
  );
  expect((await source(f))?.lifecycle_revision).toBe(1);

  // Unknown subscriptions and out-of-order deliveries are left to recovery.
  const unknown = `sub_${randomUUID().replaceAll("-", "")}`;
  objects.set(unknown, { ...f.provider, id: unknown });
  expect(
    await queue.processStripeEvent(
      delivery("customer.subscription.updated", { id: unknown, object: "subscription" }),
    ),
  ).toBe("ack");
});
