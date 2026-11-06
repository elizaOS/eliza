/** Runs the real cancellation service and repository on PGlite with only Stripe faked: a refused or lost cancel must settle instead of blocking the organization for good. */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  installCancellationTestSchema,
  seedCancellationTestAccount,
} from "../../db/repositories/subscription-cancellation-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.ENVIRONMENT = "local";
process.env.STRIPE_SECRET_KEY = "sk_test_settle";
process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro";
process.env.STRIPE_PRO_PRODUCT_ID = "prod_pro";

let customer: unknown;
let subscription: unknown;
let updateImpl = async (): Promise<unknown> => {
  throw new Error("No provider update is expected");
};
const update = mock(async (..._args: unknown[]) => updateImpl());
mock.module("../stripe", () => ({
  requireStripe: () => ({
    customers: { retrieve: async () => customer },
    subscriptions: { retrieve: async () => subscription, update },
  }),
}));
let client: typeof import("../../db/client");
let repo: typeof import("../../db/repositories/subscription-cancellation");
let service: typeof import("./subscription-cancellation");
beforeAll(async () => {
  client = await import("../../db/client");
  await installCancellationTestSchema((q) => client.getPgliteClientForTests().exec(q));
  repo = await import("../../db/repositories/subscription-cancellation");
  service = await import("./subscription-cancellation");
}, 120_000);
afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
  mock.restore();
});

const session = async () => {};
const stripeRefusal = () =>
  Object.assign(new Error("Stripe refused the update"), {
    type: "StripeAPIError",
    statusCode: 500,
  });
async function seed() {
  update.mockClear();
  updateImpl = async () => {
    throw new Error("No provider update is expected");
  };
  const f = await seedCancellationTestAccount();
  customer = { id: f.source.stripe_customer_id, object: "customer", livemode: false };
  subscription = f.provider;
  return f;
}
function scheduled(f: Awaited<ReturnType<typeof seed>>) {
  return {
    ...f.provider,
    cancel_at_period_end: true,
    cancel_at: f.provider.current_period_end,
    canceled_at: Math.floor(Date.now() / 1000),
  };
}
async function row(id: string) {
  const result = await client.getPgliteClientForTests().query<{
    status: string;
    error_code: string | null;
    cancellation_dispatch_state: string | null;
  }>(
    "SELECT status,error_code,cancellation_dispatch_state FROM billing_subscription_commands WHERE id=$1",
    [id],
  );
  return result.rows[0];
}
/** Moves the settle window's start into the past instead of waiting for it. */
async function age(id: string, column: "cancellation_dispatched_at" | "provider_started_at") {
  const ms = repo.CANCELLATION_DISPATCH_SETTLE_MS + 1000;
  await client
    .getPgliteClientForTests()
    .query(
      `UPDATE billing_subscription_commands SET ${column}=${column}-make_interval(secs => $2::double precision / 1000) WHERE id=$1`,
      [id, ms],
    );
}
async function expireLease(id: string) {
  await client
    .getPgliteClientForTests()
    .query(
      "UPDATE billing_subscription_commands SET lease_expires_at=now()-interval '1 minute' WHERE id=$1",
      [id],
    );
}

test("a refused cancel stays uncertain inside the settle window and fails after it, so a new intent can cancel", async () => {
  const f = await seed();
  updateImpl = async () => {
    throw stripeRefusal();
  };
  const first = await service.submitOrganizationSubscriptionCancellation(f.input, session);
  expect(first.status).toBe("OUTCOME_UNKNOWN");
  expect(update).toHaveBeenCalledTimes(1);

  updateImpl = async () => {
    throw new Error("A dispatched command must never be sent again");
  };
  expect(await service.recoverOrganizationSubscriptionCancellations(5)).toMatchObject({
    failed: 0,
    pending: 1,
  });
  expect(await row(first.commandId)).toMatchObject({ status: "OUTCOME_UNKNOWN" });
  await expect(
    service.submitOrganizationSubscriptionCancellation(
      { ...f.input, idempotencyKey: randomUUID() },
      session,
    ),
  ).rejects.toMatchObject({ context: { reason: "contradictory_command_pending" } });

  await age(first.commandId, "cancellation_dispatched_at");
  expect(await service.recoverOrganizationSubscriptionCancellations(5)).toMatchObject({
    failed: 1,
    pending: 0,
  });
  expect(await row(first.commandId)).toMatchObject({
    status: "FAILED",
    error_code: "PROVIDER_EFFECT_ABSENT_AFTER_SETTLE",
  });
  expect(update).toHaveBeenCalledTimes(1);

  const replay = await service.submitOrganizationSubscriptionCancellation(f.input, session);
  expect(replay).toMatchObject({ commandId: first.commandId, status: "FAILED" });

  updateImpl = async () => {
    subscription = scheduled(f);
    return subscription;
  };
  const retry = await service.submitOrganizationSubscriptionCancellation(
    { ...f.input, idempotencyKey: randomUUID() },
    session,
  );
  expect(retry.status).toBe("APPLIED");
  expect(retry.commandId).not.toBe(first.commandId);
  expect(update).toHaveBeenCalledTimes(2);
}, 120_000);

test("a worker lost between the dispatch fence and the request settles to FAILED without a resend", async () => {
  const f = await seed();
  const prepared = await repo.prepareCancellation(f.input);
  const claim = await repo.claimCancellation({ ...f.input, commandId: prepared.id });
  if (!claim) throw new Error("Missing fixture claim");
  await repo.assertCancellationClaimCurrent(f.input, claim, true);
  await expireLease(prepared.id);

  const sameKey = await service.submitOrganizationSubscriptionCancellation(f.input, session);
  expect(sameKey.status).toBe("OUTCOME_UNKNOWN");

  await age(prepared.id, "cancellation_dispatched_at");
  const settled = await service.submitOrganizationSubscriptionCancellation(f.input, session);
  expect(settled.status).toBe("FAILED");
  expect(await row(prepared.id)).toMatchObject({
    status: "FAILED",
    error_code: "PROVIDER_EFFECT_ABSENT_AFTER_SETTLE",
    cancellation_dispatch_state: "started",
  });
  expect(update).not.toHaveBeenCalled();
}, 120_000);

test("a claim that never crossed the dispatch fence fails once its window passes", async () => {
  const f = await seed();
  const prepared = await repo.prepareCancellation(f.input);
  await repo.claimCancellation({ ...f.input, commandId: prepared.id });
  await expireLease(prepared.id);
  expect(await service.recoverOrganizationSubscriptionCancellations(5)).toMatchObject({
    failed: 0,
  });
  expect(await row(prepared.id)).toMatchObject({ status: "OUTCOME_UNKNOWN" });

  await age(prepared.id, "provider_started_at");
  expect(await service.recoverOrganizationSubscriptionCancellations(5)).toMatchObject({
    failed: 1,
  });
  expect(await row(prepared.id)).toMatchObject({
    status: "FAILED",
    error_code: "NOT_DISPATCHED_BEFORE_SETTLE",
    cancellation_dispatch_state: "ready",
  });
  expect(update).not.toHaveBeenCalled();
}, 120_000);

test("a command from before dispatch tracking settles without claiming it was never sent", async () => {
  const f = await seed();
  const prepared = await repo.prepareCancellation(f.input);
  await repo.claimCancellation({ ...f.input, commandId: prepared.id });
  // Rows written before 0383 have no dispatch state; the guard trigger forbids
  // creating one now, so it is paused only to recreate that legacy shape.
  const pg = client.getPgliteClientForTests();
  await pg.exec(
    "ALTER TABLE billing_subscription_commands DISABLE TRIGGER billing_subscription_cancellation_dispatch_guard",
  );
  try {
    await pg.query(
      "UPDATE billing_subscription_commands SET cancellation_dispatch_state=NULL WHERE id=$1",
      [prepared.id],
    );
  } finally {
    await pg.exec(
      "ALTER TABLE billing_subscription_commands ENABLE TRIGGER billing_subscription_cancellation_dispatch_guard",
    );
  }
  await expireLease(prepared.id);
  await age(prepared.id, "provider_started_at");
  expect(await service.recoverOrganizationSubscriptionCancellations(5)).toMatchObject({
    failed: 1,
  });
  expect(await row(prepared.id)).toMatchObject({
    status: "FAILED",
    error_code: "DISPATCH_UNKNOWN_EFFECT_ABSENT_AFTER_SETTLE",
    cancellation_dispatch_state: null,
  });
  expect(update).not.toHaveBeenCalled();
}, 120_000);

test("an effect the provider shows after the window is still applied, not failed", async () => {
  const f = await seed();
  updateImpl = async () => {
    throw stripeRefusal();
  };
  const first = await service.submitOrganizationSubscriptionCancellation(f.input, session);
  expect(first.status).toBe("OUTCOME_UNKNOWN");
  await age(first.commandId, "cancellation_dispatched_at");
  subscription = scheduled(f);
  expect(await service.recoverOrganizationSubscriptionCancellations(5)).toMatchObject({
    applied: 1,
    failed: 0,
  });
  expect(await row(first.commandId)).toMatchObject({ status: "APPLIED" });
}, 120_000);

/** A provider observation that only moves the subscription's lifecycle revision forward, as a renewal does. */
async function renew(organizationId: string, subscriptionId: string) {
  const { subscriptionAuthorityRepository } = await import(
    "../../db/repositories/subscription-authority"
  );
  const { subscriptionEntitlementsRepository } = await import(
    "../../db/repositories/subscription-entitlements"
  );
  const current = await subscriptionAuthorityRepository.findById(organizationId, subscriptionId);
  if (!current) throw new Error("Missing fixture subscription");
  const {
    id: _id,
    organization_id: _organization,
    lifecycle_revision: revision,
    created_at: _created,
    updated_at: _updated,
    ...values
  } = current;
  const advanced = await subscriptionAuthorityRepository.advance({
    organizationId,
    subscriptionId,
    expectedRevision: revision,
    source: "webhook",
    observation: "authoritative_provider_retrieval",
    values: { ...values, provider_object_digest: randomUUID().replaceAll("-", "").repeat(2) },
  });
  const projection = await client
    .getPgliteClientForTests()
    .query<{ projection_revision: number }>(
      "SELECT projection_revision FROM organization_entitlements WHERE organization_id=$1 AND billing_scope_id IS NULL",
      [organizationId],
    );
  await subscriptionEntitlementsRepository.rebuild({
    organizationId,
    sourceSubscriptionId: subscriptionId,
    sourceSubscriptionRevision: advanced.subscription.lifecycle_revision,
    expectedProjectionRevision: Number(projection.rows[0]?.projection_revision ?? 0),
  });
  return advanced.subscription.lifecycle_revision;
}

test("a refused cancel whose subscription renewed meanwhile settles after the window, so a new intent can cancel", async () => {
  const f = await seed();
  updateImpl = async () => {
    throw stripeRefusal();
  };
  const first = await service.submitOrganizationSubscriptionCancellation(f.input, session);
  expect(first.status).toBe("OUTCOME_UNKNOWN");
  const revision = await renew(f.input.organizationId, f.input.subscriptionId);
  const next = { ...f.input, expectedSubscriptionRevision: revision };

  updateImpl = async () => {
    throw new Error("A dispatched command must never be sent again");
  };
  expect(await service.recoverOrganizationSubscriptionCancellations(5)).toMatchObject({
    failed: 0,
    unavailable: 1,
  });
  expect(await row(first.commandId)).toMatchObject({ status: "OUTCOME_UNKNOWN" });
  await expect(
    service.submitOrganizationSubscriptionCancellation(
      { ...next, idempotencyKey: randomUUID() },
      session,
    ),
  ).rejects.toMatchObject({ context: { reason: "contradictory_command_pending" } });

  await age(first.commandId, "cancellation_dispatched_at");
  expect(await service.recoverOrganizationSubscriptionCancellations(5)).toMatchObject({
    failed: 1,
    unavailable: 0,
  });
  expect(await row(first.commandId)).toMatchObject({
    status: "FAILED",
    error_code: "SUBSCRIPTION_CHANGED_EFFECT_ABSENT_AFTER_SETTLE",
  });
  expect(update).toHaveBeenCalledTimes(1);

  updateImpl = async () => {
    subscription = scheduled(f);
    return subscription;
  };
  const retry = await service.submitOrganizationSubscriptionCancellation(
    { ...next, idempotencyKey: randomUUID() },
    session,
  );
  expect(retry.status).toBe("APPLIED");
  expect(update).toHaveBeenCalledTimes(2);
}, 120_000);

test("an uncertain cancel whose renewed subscription already shows the target stays uncertain", async () => {
  const f = await seed();
  updateImpl = async () => {
    throw stripeRefusal();
  };
  const first = await service.submitOrganizationSubscriptionCancellation(f.input, session);
  await renew(f.input.organizationId, f.input.subscriptionId);
  await client
    .getPgliteClientForTests()
    .query(
      "UPDATE billing_subscriptions SET cancel_at_period_end=true, canceled_at=now() WHERE id=$1",
      [f.input.subscriptionId],
    );
  await age(first.commandId, "cancellation_dispatched_at");
  expect(await service.recoverOrganizationSubscriptionCancellations(5)).toMatchObject({
    failed: 0,
  });
  expect(await row(first.commandId)).toMatchObject({ status: "OUTCOME_UNKNOWN" });
}, 120_000);

async function dispatchedAt(id: string) {
  const result = await client
    .getPgliteClientForTests()
    .query<{ cancellation_dispatched_at: Date | null }>(
      "SELECT cancellation_dispatched_at FROM billing_subscription_commands WHERE id=$1",
      [id],
    );
  return result.rows[0]?.cancellation_dispatched_at ?? null;
}
/** A command an isolate older than 0554 fenced after that migration's backfill ran. */
async function forgetDispatchTime(id: string) {
  await client
    .getPgliteClientForTests()
    .query("UPDATE billing_subscription_commands SET cancellation_dispatched_at=NULL WHERE id=$1", [
      id,
    ]);
}

test("a command an old isolate fenced without a dispatch time starts its window at recovery and settles after it", async () => {
  const f = await seed();
  updateImpl = async () => {
    throw stripeRefusal();
  };
  const first = await service.submitOrganizationSubscriptionCancellation(f.input, session);
  expect(first.status).toBe("OUTCOME_UNKNOWN");
  await forgetDispatchTime(first.commandId);
  await age(first.commandId, "provider_started_at");

  updateImpl = async () => {
    throw new Error("A dispatched command must never be sent again");
  };
  expect(await service.recoverOrganizationSubscriptionCancellations(5)).toMatchObject({
    failed: 0,
    pending: 1,
  });
  expect(await dispatchedAt(first.commandId)).not.toBeNull();

  await age(first.commandId, "cancellation_dispatched_at");
  expect(await service.recoverOrganizationSubscriptionCancellations(5)).toMatchObject({
    failed: 1,
  });
  expect(await row(first.commandId)).toMatchObject({
    status: "FAILED",
    error_code: "PROVIDER_EFFECT_ABSENT_AFTER_SETTLE",
  });
  expect(update).toHaveBeenCalledTimes(1);
}, 120_000);

test("a stale command an old isolate fenced without a dispatch time keeps the window start and settles after it", async () => {
  const f = await seed();
  updateImpl = async () => {
    throw stripeRefusal();
  };
  const first = await service.submitOrganizationSubscriptionCancellation(f.input, session);
  await renew(f.input.organizationId, f.input.subscriptionId);
  await forgetDispatchTime(first.commandId);
  await age(first.commandId, "provider_started_at");

  expect(await service.recoverOrganizationSubscriptionCancellations(5)).toMatchObject({
    failed: 0,
    pending: 1,
  });
  expect(await dispatchedAt(first.commandId)).not.toBeNull();

  await age(first.commandId, "cancellation_dispatched_at");
  expect(await service.recoverOrganizationSubscriptionCancellations(5)).toMatchObject({
    failed: 1,
  });
  expect(await row(first.commandId)).toMatchObject({
    status: "FAILED",
    error_code: "SUBSCRIPTION_CHANGED_EFFECT_ABSENT_AFTER_SETTLE",
  });
}, 120_000);

test("a stale command stays uncertain while a Stripe event for its subscription waits in the outbox", async () => {
  const f = await seed();
  updateImpl = async () => {
    throw stripeRefusal();
  };
  const first = await service.submitOrganizationSubscriptionCancellation(f.input, session);
  await renew(f.input.organizationId, f.input.subscriptionId);
  await age(first.commandId, "cancellation_dispatched_at");
  const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
  const pg = client.getPgliteClientForTests();
  await pg.query(
    "INSERT INTO webhook_events(event_id,provider,event_type,payload_hash,delivery_payload) VALUES ($1,'stripe','customer.subscription.updated',$2,$3::jsonb)",
    [
      eventId,
      "a".repeat(64),
      JSON.stringify({
        kind: "stripe.event",
        eventId,
        eventType: "customer.subscription.updated",
        event: {
          id: eventId,
          type: "customer.subscription.updated",
          data: { object: { id: f.source.stripe_subscription_id, cancel_at_period_end: true } },
        },
        receivedAt: Date.now(),
      }),
    ],
  );
  expect(await service.recoverOrganizationSubscriptionCancellations(5)).toMatchObject({
    failed: 0,
  });
  expect(await row(first.commandId)).toMatchObject({ status: "OUTCOME_UNKNOWN" });

  await pg.query("UPDATE webhook_events SET delivery_completed_at=now() WHERE event_id=$1", [
    eventId,
  ]);
  expect(await service.recoverOrganizationSubscriptionCancellations(5)).toMatchObject({
    failed: 1,
  });
  expect(await row(first.commandId)).toMatchObject({
    status: "FAILED",
    error_code: "SUBSCRIPTION_CHANGED_EFFECT_ABSENT_AFTER_SETTLE",
  });
}, 120_000);
