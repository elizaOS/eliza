/**
 * Replays concurrent Stripe deliveries through the real webhook route and the
 * cron's delivery lane on the cache configuration the production Worker has
 * checked in: CACHE_BACKEND=auto with a CACHE_KV binding, which selects the
 * KV adapter. Only Stripe signing, the KV namespace and the database (PGlite,
 * built from the Drizzle schema) are stand-ins. When the route queued work in a
 * KV list, concurrent deliveries all got 200 while the list kept one of them,
 * and Stripe's resend of a lost event was answered as a duplicate. Every
 * delivery that gets a 200 must reach the consumer.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { Hono } from "hono";
import Stripe from "stripe";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
setDefaultTimeout(60_000);

const WEBHOOK_SECRET = "whsec_outbox_replay";

/** A KV namespace whose reads wait for each other while `contended`, as concurrent Worker isolates do. */
class ContendedKv {
  readonly store = new Map<string, string>();
  contended = false;
  private waiting: Array<() => void> = [];
  async get(key: string): Promise<string | null> {
    if (this.contended) {
      await new Promise<void>((release) => {
        this.waiting.push(release);
        if (this.waiting.length === 3)
          for (const next of this.waiting.splice(0)) next();
        else setTimeout(release, 250);
      });
    }
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async list() {
    return { keys: [], list_complete: true };
  }
}
const kv = new ContendedKv();
const bindings = {
  CACHE_ENABLED: "true",
  CACHE_BACKEND: "auto",
  CACHE_KV: kv,
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_SECRET_KEY: "sk_test_outbox_replay",
};

const { runWithCloudBindingsAsync } = await import(
  "@elizaos/cloud-shared/lib/runtime/cloud-bindings"
);
const { closeDatabaseConnectionsForTests, getPgliteClientForTests, dbWrite } =
  await import("@elizaos/cloud-shared/db/client");
const { webhookEvents } = await import("@elizaos/cloud-shared/db/schemas");
const { cache } = await import("@elizaos/cloud-shared/lib/cache/client");
const { enqueue } = await import("@elizaos/cloud-shared/lib/redis-queue");
const { drainStripeDeliveries } = await import(
  "@elizaos/cloud-shared/lib/services/stripe-delivery-outbox"
);
const { handleStripeWebhook } = await import("../stripe/webhook/route");

const signing = new Stripe("sk_test_signature_fixture");
const app = new Hono<AppEnv>();
app.post("/", (c) => handleStripeWebhook(c));
const inWorker = <T>(fn: () => Promise<T>) =>
  runWithCloudBindingsAsync(bindings, fn);

beforeAll(async () => {
  await dbWrite.execute("SELECT 1");
  const empty = generateDrizzleJson({});
  for (const statement of await generateMigration(
    empty,
    generateDrizzleJson({ webhookEvents }, empty.id),
  ))
    await getPgliteClientForTests().exec(statement.replaceAll('"public".', ""));
  // The cache client and the database client both detect a Worker by this
  // global. The cache picks its backend once, as the Worker does; the global is
  // then removed because PGlite refuses to open inside a Worker.
  const worker = globalThis as { WebSocketPair?: unknown };
  worker.WebSocketPair = class {};
  await inWorker(async () => cache.getBackendKind());
  delete worker.WebSocketPair;
});
afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

function event(id: string, type: string, object: Record<string, unknown>) {
  return JSON.stringify({
    id,
    object: "event",
    type,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    api_version: "2024-11-20.acacia",
    data: { object },
  });
}
async function deliver(body: string) {
  const response = await inWorker(async () =>
    app.fetch(
      new Request("http://cloud.test/", {
        method: "POST",
        body,
        headers: {
          "stripe-signature":
            await signing.webhooks.generateTestHeaderStringAsync({
              payload: body,
              secret: WEBHOOK_SECRET,
            }),
        },
      }),
      bindings,
    ),
  );
  return { status: response.status, json: await response.json() };
}
/** One cron tick of the Stripe delivery lane; returns the event ids the consumer saw. */
async function cronTick() {
  const seen: string[] = [];
  await inWorker(() =>
    drainStripeDeliveries(async ({ body }) => {
      seen.push(body.eventId);
      return "ack";
    }),
  );
  return seen;
}

test("the checked-in Worker cache config selects KV, which refuses to hold a work queue", async () => {
  await inWorker(async () => {
    expect(cache.getBackendKind()).toBe("cloudflare_kv");
    expect(cache.supportsAtomicOperations()).toBe(false);
    await expect(enqueue("stripe-events", { id: "evt" })).rejects.toThrow(
      "atomic list operations",
    );
  });
});

test("concurrent deliveries that each got a 200 all reach the consumer, and a resend stays a duplicate", async () => {
  const bodies = [
    event("evt_outbox_checkout", "checkout.session.completed", {
      id: "cs_outbox",
      object: "checkout.session",
      mode: "payment",
      payment_intent: "pi_outbox_checkout",
    }),
    event("evt_outbox_payment", "payment_intent.succeeded", {
      id: "pi_outbox_payment",
      object: "payment_intent",
    }),
    event("evt_outbox_refund", "charge.refunded", {
      id: "ch_outbox",
      object: "charge",
    }),
  ];
  kv.contended = true;
  const responses = await Promise.all(bodies.map(deliver));
  kv.contended = false;
  expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);

  const delivered = await cronTick();
  expect(delivered.sort()).toEqual(
    ["evt_outbox_checkout", "evt_outbox_payment", "evt_outbox_refund"].sort(),
  );
  expect(await cronTick()).toEqual([]);

  const resend = await deliver(bodies[0]!);
  expect(resend).toEqual({
    status: 200,
    json: { received: true, duplicate: true },
  });
  expect(await cronTick()).toEqual([]);
});

test("a resend of a dead-lettered delivery is delivered again", async () => {
  const body = event("evt_outbox_dead", "charge.refunded", {
    id: "ch_dead",
    object: "charge",
  });
  expect((await deliver(body)).status).toBe(200);
  await inWorker(() => drainStripeDeliveries(async () => "dlq"));
  expect(await cronTick()).toEqual([]);

  expect(await deliver(body)).toEqual({
    status: 200,
    json: { received: true, queued: true },
  });
  expect(await cronTick()).toEqual(["evt_outbox_dead"]);
});
