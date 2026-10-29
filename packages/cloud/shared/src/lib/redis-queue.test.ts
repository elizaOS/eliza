/**
 * `drain` pops a delivery before it runs the handler. Until the outcome is
 * written back the delivery exists only in the draining process, so a
 * failed push-back or a dead isolate lost it while the webhook dedupe marker
 * kept the provider from re-sending it. The processing list keeps every
 * claimed delivery durable until it is settled; the next drain re-runs what
 * an earlier drain left behind.
 */

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";

// In-memory by default; CACHE_BACKEND=wadis runs the same suite on the embedded Redis engine.
const fixtureEnvironment = {
  CACHE_ENABLED: "true",
  CACHE_BACKEND: process.env.CACHE_BACKEND === "wadis" ? "wadis" : "memory",
};
const previousEnvironment = Object.fromEntries(
  Object.keys(fixtureEnvironment).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, fixtureEnvironment);

type QueueModule = typeof import("./redis-queue");
type CacheModule = typeof import("./cache/client");

let queue: QueueModule;
let cache: CacheModule["cache"];

interface Delivery {
  id: string;
}

beforeAll(async () => {
  queue = await import("./redis-queue");
  ({ cache } = await import("./cache/client"));
  // Wadis boots asynchronously; the first command waits for it.
  await cache.getQueueLength(queueKey());
  expect(cache.getBackendKind()).toBe(fixtureEnvironment.CACHE_BACKEND);
});

afterAll(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function queueKey(): string {
  return `queue-test:${randomUUID()}`;
}

/** Drains once with an acking handler and returns what it handled. */
async function drainOnce(key: string): Promise<Array<{ id: string; attempts: number }>> {
  const seen: Array<{ id: string; attempts: number }> = [];
  await queue.drain<Delivery>(
    key,
    async ({ body, attempts }) => {
      seen.push({ id: body.id, attempts });
      return "ack";
    },
    { retryBaseDelayMs: 0 },
  );
  return seen;
}

test("a retried delivery whose push-back fails is re-run by the next drain", async () => {
  const key = queueKey();
  await queue.enqueue<Delivery>(key, { id: "evt_push_back" });

  const pushSpy = spyOn(cache, "pushQueueHead").mockResolvedValueOnce(null);
  try {
    await expect(
      queue.drain<Delivery>(key, async () => "retry", { retryBaseDelayMs: 0 }),
    ).rejects.toThrow(/Redis unavailable/);
  } finally {
    pushSpy.mockRestore();
  }

  // The next drain finds the claimed delivery and requeues it as one more attempt.
  const recovery = await queue.drain<Delivery>(key, async () => "ack", { retryBaseDelayMs: 0 });
  expect(recovery).toMatchObject({ recovered: 1, retried: 1, attempted: 0 });
  expect(await cache.listQueue(`${key}:processing`)).toEqual([]);

  const seen = await drainOnce(key);
  expect(seen).toEqual([{ id: "evt_push_back", attempts: 1 }]);
  expect(await queue.queueLength(key)).toBe(0);
  expect(await cache.listQueue(`${key}:processing`)).toEqual([]);
});

test("a delivery claimed by a drain that never finishes is re-run by the next drain", async () => {
  const key = queueKey();
  await queue.enqueue<Delivery>(key, { id: "evt_dead_isolate" });

  // The first drain dies inside the handler: it never settles the delivery.
  const dead = queue.drain<Delivery>(key, () => new Promise<never>(() => {}), { leaseMs: 20 });
  await Bun.sleep(40);

  const recovery = await queue.drain<Delivery>(key, async () => "ack", { retryBaseDelayMs: 0 });
  expect(recovery).toMatchObject({ recovered: 1, retried: 1, attempted: 0 });

  const seen = await drainOnce(key);
  expect(seen).toEqual([{ id: "evt_dead_isolate", attempts: 1 }]);
  expect(await queue.queueLength(key)).toBe(0);
  expect(await cache.listQueue(`${key}:processing`)).toEqual([]);
  void dead;
});

test("an abandoned delivery out of retry budget is dead-lettered, not re-run forever", async () => {
  const key = queueKey();
  const envelope = { body: { id: "evt_poison" }, attempts: 2, enqueuedAt: Date.now() };
  await cache.pushQueueHead(`${key}:processing`, JSON.stringify(envelope));

  const handled: string[] = [];
  const deadLettered: Array<{ id: string; attempts: number }> = [];
  const stats = await queue.drain<Delivery>(
    key,
    async ({ body }) => {
      handled.push(body.id);
      return "ack";
    },
    {
      maxAttempts: 3,
      onDeadLetter: async ({ body, attempts }) => {
        deadLettered.push({ id: body.id, attempts });
      },
    },
  );

  expect(handled).toEqual([]);
  expect(stats.recovered).toBe(1);
  expect(stats.dlqed).toBe(1);
  expect(deadLettered).toEqual([{ id: "evt_poison", attempts: 3 }]);
  expect(await cache.listQueue(`${key}:processing`)).toEqual([]);
  expect(await queue.queueLength(`${key}:dlq`)).toBe(1);
});

test("a second drain does not pop while another drain holds the lease", async () => {
  const key = queueKey();
  await queue.enqueue<Delivery>(key, { id: "evt_a" });
  await queue.enqueue<Delivery>(key, { id: "evt_b" });

  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first: string[] = [];
  const firstDrain = queue.drain<Delivery>(key, async ({ body }) => {
    first.push(body.id);
    await gate;
    return "ack";
  });
  await Bun.sleep(10);

  const second: string[] = [];
  const secondStats = await queue.drain<Delivery>(key, async ({ body }) => {
    second.push(body.id);
    return "ack";
  });
  expect(secondStats.skipped).toBe(true);
  expect(second).toEqual([]);

  release();
  const firstStats = await firstDrain;
  expect(first).toEqual(["evt_a", "evt_b"]);
  expect(firstStats.acked).toBe(2);
  expect(await queue.queueLength(key)).toBe(0);
  expect(await cache.listQueue(`${key}:processing`)).toEqual([]);
});

test("settled deliveries leave the processing list empty", async () => {
  const key = queueKey();
  await queue.enqueue<Delivery>(key, { id: "evt_ack" });
  await queue.enqueue<Delivery>(key, { id: "evt_retry" });
  await queue.enqueue<Delivery>(key, { id: "evt_dlq" });
  await cache.pushQueueHead(key, "not json");

  const stats = await queue.drain<Delivery>(
    key,
    async ({ body }) => {
      if (body.id === "evt_retry") return "retry";
      if (body.id === "evt_dlq") return "dlq";
      return "ack";
    },
    { retryBaseDelayMs: 60_000 },
  );

  expect(stats).toMatchObject({ acked: 1, retried: 1, dlqed: 1, failed: 1, recovered: 0 });
  expect(await cache.listQueue(`${key}:processing`)).toEqual([]);
  expect(await queue.queueLength(key)).toBe(1);
  expect(await queue.queueLength(`${key}:dlq`)).toBe(1);
});
