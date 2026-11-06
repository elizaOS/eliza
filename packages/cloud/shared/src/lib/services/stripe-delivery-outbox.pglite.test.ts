/** Runs the Stripe delivery outbox on PGlite with the real migration: leases, crash recovery, retry budget, dead-letter revival, retention and adoption of the pre-outbox queue. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type Stripe from "stripe";
import type { StripeEventMessage } from "../../types/stripe-queue-message";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.CACHE_ENABLED = "true";
process.env.CACHE_BACKEND = "memory";

let client: typeof import("../../db/client");
let repo: typeof import("../../db/repositories/webhook-events")["webhookEventsRepository"];
let outbox: typeof import("./stripe-delivery-outbox");
let cache: typeof import("../cache/client")["cache"];
beforeAll(async () => {
  client = await import("../../db/client");
  const db = client.getPgliteClientForTests();
  await db.exec(
    `CREATE TABLE webhook_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_id text NOT NULL UNIQUE,provider text NOT NULL,event_type text,payload_hash text NOT NULL,source_ip text,processed_at timestamp NOT NULL DEFAULT now(),event_timestamp timestamp,
      app_billing_trigger jsonb,app_billing_completed_at timestamptz,app_billing_next_attempt_at timestamptz NOT NULL DEFAULT now(),app_billing_error_code text)`,
  );
  for (const tag of ["0555_stripe_delivery_outbox", "0556_stripe_delivery_outbox_due_index"]) {
    const migration = await readFile(
      new URL(`../../db/migrations/${tag}.sql`, import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint"))
      if (statement.trim()) await db.exec(statement);
  }
  repo = (await import("../../db/repositories/webhook-events")).webhookEventsRepository;
  outbox = await import("./stripe-delivery-outbox");
  ({ cache } = await import("../cache/client"));
}, 120_000);
afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
});

function message(eventId = `evt_${randomUUID().replaceAll("-", "")}`): StripeEventMessage {
  return {
    kind: "stripe.event",
    eventId,
    eventType: "charge.refunded",
    event: { id: eventId, object: "event", type: "charge.refunded" } as Stripe.Event,
    receivedAt: Date.now(),
  };
}
async function record(payload = message()) {
  const created = await repo.tryCreate({
    event_id: payload.eventId,
    provider: "stripe",
    event_type: payload.eventType,
    payload_hash: "a".repeat(64),
    delivery_payload: payload,
  });
  expect(created.created).toBe(true);
  return payload;
}
async function row(eventId: string) {
  const result = await client
    .getPgliteClientForTests()
    .query<Record<string, unknown>>(
      "SELECT delivery_attempts,delivery_completed_at,delivery_dead_lettered_at,delivery_lease_token FROM webhook_events WHERE event_id=$1",
      [eventId],
    );
  return result.rows[0];
}
async function sql(statement: string, eventId: string) {
  await client.getPgliteClientForTests().query(statement, [eventId]);
}
const expireLease = (eventId: string) =>
  sql(
    "UPDATE webhook_events SET delivery_lease_expires_at=now()-interval '1 second' WHERE event_id=$1",
    eventId,
  );
const makeDue = (eventId: string) =>
  sql("UPDATE webhook_events SET delivery_next_attempt_at=now() WHERE event_id=$1", eventId);
/** Drains once and returns the deliveries the handler saw. */
async function drain(result: "ack" | "retry" | "dlq" = "ack", maxAttempts = 8) {
  const seen: Array<{ eventId: string; attempts: number }> = [];
  const stats = await outbox.drainStripeDeliveries(
    async ({ body, attempts }) => {
      seen.push({ eventId: body.eventId, attempts });
      return result;
    },
    { maxAttempts },
  );
  return { seen, stats };
}
async function settleAll() {
  while ((await drain()).seen.length > 0);
}

test("a leased delivery is claimed once; an expired lease is claimed again and the old holder cannot settle", async () => {
  await settleAll();
  const payload = await record();
  const [first, second] = await Promise.all([
    repo.claimDueStripeDeliveries(25, 60_000),
    repo.claimDueStripeDeliveries(25, 60_000),
  ]);
  expect([...first!, ...second!].map((delivery) => delivery.eventId)).toEqual([payload.eventId]);
  const held = [...first!, ...second!][0]!;
  expect(held.attempts).toBe(1);
  expect(await repo.claimDueStripeDeliveries(25, 60_000)).toEqual([]);

  await expireLease(payload.eventId);
  const [reclaimed] = await repo.claimDueStripeDeliveries(25, 60_000);
  expect(reclaimed).toMatchObject({ eventId: payload.eventId, attempts: 2 });
  expect(await repo.completeStripeDelivery(held)).toBe(false);
  expect(await repo.completeStripeDelivery(reclaimed!)).toBe(true);
  expect(await repo.claimDueStripeDeliveries(25, 60_000)).toEqual([]);
});

test("a drain that dies after its claim leaves the delivery to the next drain, which completes it once", async () => {
  await settleAll();
  const payload = await record();
  await repo.claimDueStripeDeliveries(25, 60_000); // this drain dies before any settle
  expect((await drain()).seen).toEqual([]);
  await expireLease(payload.eventId);
  expect((await drain()).seen).toEqual([{ eventId: payload.eventId, attempts: 1 }]);
  expect((await drain()).seen).toEqual([]);
  expect(await row(payload.eventId)).toMatchObject({
    delivery_attempts: 2,
    delivery_lease_token: null,
    delivery_dead_lettered_at: null,
  });
  expect((await row(payload.eventId))?.delivery_completed_at).not.toBeNull();
});

test("retries back off, a spent budget dead-letters, and a resend makes it due with a fresh budget", async () => {
  await settleAll();
  const payload = await record();
  const retried = await drain("retry", 2);
  expect(retried.stats).toMatchObject({ attempted: 1, retried: 1 });
  expect((await drain("retry", 2)).seen).toEqual([]);
  await makeDue(payload.eventId);
  expect((await drain("retry", 2)).stats).toMatchObject({ attempted: 1, dlqed: 1 });
  await makeDue(payload.eventId);
  expect((await drain()).seen).toEqual([]);

  expect(await repo.reviveDeadStripeDelivery(payload.eventId, payload)).toBe(true);
  expect((await drain()).seen).toEqual([{ eventId: payload.eventId, attempts: 0 }]);
  expect(await repo.reviveDeadStripeDelivery(payload.eventId, payload)).toBe(false);
});

test("a delivery whose last attempt died is dead-lettered without running again", async () => {
  await settleAll();
  const payload = await record();
  for (let attempt = 0; attempt < 2; attempt++) {
    await repo.claimDueStripeDeliveries(25, 60_000);
    await expireLease(payload.eventId);
  }
  const { seen, stats } = await drain("ack", 2);
  expect(seen).toEqual([]);
  expect(stats).toMatchObject({ claimed: 1, dlqed: 1 });
  expect((await row(payload.eventId))?.delivery_dead_lettered_at).not.toBeNull();
});

for (const [name, cleanup] of [
  ["cleanupOldEvents (the retention cron)", () => repo.cleanupOldEvents(30)],
  ["cleanupOldEventsForProvider", () => repo.cleanupOldEventsForProvider("stripe", 30)],
] as const)
  test(`retention never deletes undelivered work: ${name}`, async () => {
    await settleAll();
    const done = await record();
    const dead = await record();
    await drain();
    await sql(
      "UPDATE webhook_events SET delivery_completed_at=NULL,delivery_dead_lettered_at=now() WHERE event_id=$1",
      dead.eventId,
    );
    const pending = await record();
    const dueNow = await record();
    const leased = await record();
    await sql(
      "UPDATE webhook_events SET delivery_next_attempt_at=now()+interval '1 hour' WHERE event_id=$1",
      pending.eventId,
    );
    await sql(
      "UPDATE webhook_events SET delivery_lease_token=gen_random_uuid(),delivery_lease_expires_at=now()+interval '1 hour' WHERE event_id=$1",
      leased.eventId,
    );
    const all = [done, dead, pending, dueNow, leased];
    for (const { eventId } of all)
      await sql(
        "UPDATE webhook_events SET processed_at=now()-interval '40 days' WHERE event_id=$1",
        eventId,
      );
    await cleanup();
    for (const { eventId } of [pending, dueNow, leased]) expect(await row(eventId)).toBeDefined();
    for (const { eventId } of [done, dead]) expect(await row(eventId)).toBeUndefined();
    await sql(
      "UPDATE webhook_events SET delivery_lease_expires_at=now()-interval '1 second' WHERE event_id=$1",
      leased.eventId,
    );
    await makeDue(pending.eventId);
  });

test("rows a drain claimed but did not reach inside its budget keep their attempts and are claimed at once", async () => {
  await settleAll();
  const first = await record();
  const rest = [await record(), await record()];
  const seen: string[] = [];
  const stats = await outbox.drainStripeDeliveries(
    async ({ body }) => {
      seen.push(body.eventId);
      await new Promise((resolve) => setTimeout(resolve, 400));
      return "ack";
    },
    { budgetMs: 200 },
  );
  expect(stats).toMatchObject({ claimed: 3, attempted: 1, released: 2 });
  const reached = seen[0]!;
  const unreached = [first, ...rest].map(({ eventId }) => eventId).filter((id) => id !== reached);
  for (const eventId of unreached)
    expect(await row(eventId)).toMatchObject({ delivery_attempts: 0, delivery_lease_token: null });
  const reclaimed = await repo.claimDueStripeDeliveries(25, 60_000);
  expect(reclaimed.map(({ eventId }) => eventId).sort()).toEqual(unreached.sort());
  expect(reclaimed.map(({ attempts }) => attempts)).toEqual([1, 1]);
  for (const delivery of reclaimed) await repo.completeStripeDelivery(delivery);
});

test("deliveries left on the pre-outbox queue are moved into the outbox and delivered once", async () => {
  await settleAll();
  // A marker written by the old route, whose work only the old list holds.
  const legacy = message();
  await repo.tryCreate({
    event_id: legacy.eventId,
    provider: "stripe",
    event_type: legacy.eventType,
    payload_hash: "b".repeat(64),
  });
  // Work whose marker the old dead-letter path had released.
  const released = message();
  for (const body of [legacy, released])
    await cache.pushQueueHead(
      "stripe-events",
      JSON.stringify({ body, attempts: 0, enqueuedAt: Date.now() }),
    );

  const { seen, stats } = await drain();
  expect(stats.legacyAdopted).toBe(2);
  expect(seen.map((delivery) => delivery.eventId).sort()).toEqual(
    [legacy.eventId, released.eventId].sort(),
  );
  expect(await cache.getQueueLength("stripe-events")).toBe(0);
  expect((await drain()).seen).toEqual([]);
});

test("a legacy entry that cannot be adopted stays listed and never blocks the outbox drain", async () => {
  await settleAll();
  const due = await record();
  // Its event id is missing, so writing its row violates the schema.
  const poison = JSON.stringify({
    body: { ...message(), eventId: null },
    attempts: 0,
    enqueuedAt: Date.now(),
  });
  const deadLettered = message();
  await cache.pushQueueHead("stripe-events", poison);
  await cache.pushQueueHead(
    "stripe-events:dlq",
    JSON.stringify({ body: deadLettered, attempts: 8, enqueuedAt: Date.now() }),
  );

  const { seen, stats } = await drain();
  expect(stats.legacyAdopted).toBe(1);
  expect(seen.map(({ eventId }) => eventId).sort()).toEqual(
    [due.eventId, deadLettered.eventId].sort(),
  );
  expect(await cache.listQueue("stripe-events")).toEqual([poison]);
  expect(await cache.getQueueLength("stripe-events:dlq")).toBe(0);
  await cache.removeQueueValue("stripe-events", poison);
});
