import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  closeDb,
  getDb,
  setPGLiteOverride,
  tenants,
  webhookConfigs,
  webhookDeliveries,
} from "../db/index";
import { createPGLiteDb } from "../db/pglite";
import type { WebhookEvent } from "../shared/index";
import {
  PersistentQueue,
  verifyWebhookSignature,
  WebhookDispatcher,
} from "../webhooks/index";
import type { WebhookDeliveryResult } from "../webhooks/types";

const priorPassword = process.env.STEWARD_MASTER_PASSWORD;
beforeAll(async () => {
  process.env.STEWARD_MASTER_PASSWORD = "fixture-secret-for-webhook-encryption";
  const database = await createPGLiteDb("memory://");
  setPGLiteOverride(database.db, () => database.client.close());
  await getDb().insert(tenants).values({
    id: "queue-fixture",
    name: "Queue fixture",
    apiKeyHash: "fixture",
  });
}, 60_000);
afterAll(async () => {
  await closeDb();
  if (priorPassword === undefined) delete process.env.STEWARD_MASTER_PASSWORD;
  else process.env.STEWARD_MASTER_PASSWORD = priorPassword;
});

class Dispatcher extends WebhookDispatcher {
  constructor(
    private readonly send: (
      event: WebhookEvent,
    ) => Promise<WebhookDeliveryResult>,
  ) {
    super();
  }
  override dispatch(event: WebhookEvent) {
    return this.send(event);
  }
}
async function fixture(queue: PersistentQueue) {
  const [config] = await getDb()
    .insert(webhookConfigs)
    .values({
      tenantId: "queue-fixture",
      url: `https://${randomUUID()}.example.test`,
      secret: "fixture",
      retryBackoffMs: 60_000,
    })
    .returning();
  const event: WebhookEvent = {
    type: "webhook.test",
    tenantId: config.tenantId,
    timestamp: new Date(),
    data: {},
  };
  const id = await queue.enqueue(event, config);
  return { id, config };
}

test("typed claims retain the original configuration and tenant scope", async () => {
  let sentId: unknown;
  const queue = new PersistentQueue(
    new Dispatcher(async (event) => {
      sentId = (event as WebhookEvent & { deliveryId: string }).deliveryId;
      return { success: true, attempts: 1, deliveredAt: new Date() };
    }),
  );
  const { id } = await fixture(queue);
  expect(await queue.processDelivery(id, "another-tenant")).toBeUndefined();
  expect(await queue.getDelivery(id, "another-tenant")).toBeNull();
  expect((await queue.processDelivery(id, "queue-fixture"))?.success).toBe(
    true,
  );
  expect(sentId).toBe(id);
  expect(await queue.getDelivery(id, "queue-fixture")).toMatchObject({
    status: "delivered",
    attempts: 1,
  });
});

test("a restarted worker retries a persisted failed delivery", async () => {
  const first = new PersistentQueue(
    new Dispatcher(async () => ({
      success: false,
      attempts: 1,
      error: "temporary",
    })),
  );
  const { id } = await fixture(first);
  await first.processDelivery(id, "queue-fixture");
  expect(await first.getDelivery(id, "queue-fixture")).toMatchObject({
    status: "failed",
    attempts: 1,
  });
  await getDb()
    .update(webhookDeliveries)
    .set({ nextRetryAt: new Date(0) })
    .where(eq(webhookDeliveries.id, id));
  const second = new PersistentQueue(
    new Dispatcher(async () => ({
      success: true,
      attempts: 1,
      deliveredAt: new Date(),
    })),
  );
  await second.processQueue();
  expect(await second.getDelivery(id, "queue-fixture")).toMatchObject({
    status: "delivered",
    attempts: 2,
  });
});

test("an expired owner cannot overwrite a newer delivery receipt", async () => {
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: (value: WebhookDeliveryResult) => void;
  const pending = new Promise<WebhookDeliveryResult>((resolve) => {
    finish = resolve;
  });
  const first = new PersistentQueue(
    new Dispatcher(async () => {
      started();
      return pending;
    }),
  );
  const { id } = await fixture(first);
  const active = first.processDelivery(id, "queue-fixture");
  try {
    await entered;
    await getDb()
      .update(webhookDeliveries)
      .set({ nextRetryAt: new Date(0) })
      .where(eq(webhookDeliveries.id, id));
    const second = new PersistentQueue(
      new Dispatcher(async () => ({
        success: true,
        attempts: 1,
        deliveredAt: new Date(),
      })),
    );
    await second.processDelivery(id, "queue-fixture");
  } finally {
    finish({ success: false, attempts: 1, error: "late failure" });
    await active;
  }
  expect(await first.getDelivery(id, "queue-fixture")).toMatchObject({
    status: "delivered",
    attempts: 2,
    lastError: null,
  });
});

test("old persisted events get a fresh verifiable delivery signature", async () => {
  let verified = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      verified = verifyWebhookSignature({
        body: await request.text(),
        deliveryId: request.headers.get("X-Steward-Delivery-Id") ?? "",
        eventType: request.headers.get("X-Steward-Event") ?? "",
        sentAt: request.headers.get("X-Steward-Sent-At") ?? "",
        signature: request.headers.get("X-Steward-Signature") ?? "",
        secret: "fixture",
      });
      return new Response("ok");
    },
  });
  try {
    const event = {
      type: "webhook.test" as const,
      tenantId: "queue-fixture",
      timestamp: new Date(0),
      data: {},
      signedAt: 1,
      deliveryId: "stable-id",
    };
    const dispatcher = new WebhookDispatcher({
      maxRetries: 0,
      allowPrivateNetwork: true,
      allowInsecureHttp: true,
    });
    expect(
      await dispatcher.dispatch(event, {
        url: server.url.toString(),
        secret: "fixture",
      }),
    ).toMatchObject({ success: true, deliveryId: "stable-id" });
    expect(verified).toBe(true);
  } finally {
    server.stop(true);
  }
});
