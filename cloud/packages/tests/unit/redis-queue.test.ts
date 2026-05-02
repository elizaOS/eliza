import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { DrainHandler } from "../../lib/queue/redis-queue.ts";

const originalEnv = { ...process.env };

type TestBody = { value: string };

function configureQueueEnv() {
  process.env.CACHE_ENABLED = "true";
  process.env.CACHE_BACKEND = "wadis";
  process.env.NODE_ENV = "test";
  process.env.ENVIRONMENT = "test";
  delete process.env.REDIS_URL;
  delete process.env.KV_URL;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("Redis queue helper", () => {
  beforeAll(async () => {
    mock.restore();
    configureQueueEnv();

    // Provide a fresh Wadis instance directly so this test is isolated from
    // any @/lib/cache/client module mock that a preceding test left behind.
    const { Wadis } = await import("wadis");
    const w = new Wadis() as {
      lpush(key: string, ...values: string[]): Promise<number>;
      rpop(key: string): Promise<string | null>;
      llen(key: string): Promise<number>;
    };

    mock.module("@/lib/cache/client", () => ({
      cache: {
        pushQueueHead: (key: string, ...values: string[]) => w.lpush(key, ...values),
        popQueueTail: (key: string) => w.rpop(key),
        getQueueLength: (key: string) => w.llen(key),
      },
    }));
  });

  afterAll(() => {
    restoreEnv();
    mock.restore();
  });

  test("drains FIFO messages and tracks ack/retry/dlq stats", async () => {
    const queue = await import(
      new URL(`../../lib/queue/redis-queue.ts?t=${Date.now()}`, import.meta.url).href
    );
    const queueKey = `test:queue:${crypto.randomUUID()}`;
    const seen: Array<{ value: string; attempts: number }> = [];

    await queue.enqueue(queueKey, { value: "ack-1" });
    await queue.enqueue(queueKey, { value: "retry-once" });
    await queue.enqueue(queueKey, { value: "dlq-now" });

    const firstHandler: DrainHandler<TestBody> = async (envelope) => {
      seen.push({ value: envelope.body.value, attempts: envelope.attempts });
      if (envelope.body.value === "retry-once" && envelope.attempts === 0) {
        return "retry";
      }
      if (envelope.body.value === "dlq-now") {
        return "dlq";
      }
      return "ack";
    };

    const firstStats = await queue.drain(queueKey, firstHandler, { max: 3, maxAttempts: 3 });

    expect(firstStats).toEqual({
      attempted: 3,
      acked: 1,
      retried: 1,
      dlqed: 1,
      failed: 0,
    });
    expect(seen).toEqual([
      { value: "ack-1", attempts: 0 },
      { value: "retry-once", attempts: 0 },
      { value: "dlq-now", attempts: 0 },
    ]);

    const secondHandler: DrainHandler<TestBody> = async (envelope) => {
      seen.push({ value: envelope.body.value, attempts: envelope.attempts });
      return "ack";
    };

    const secondStats = await queue.drain(queueKey, secondHandler, { max: 3, maxAttempts: 3 });

    expect(secondStats).toEqual({
      attempted: 1,
      acked: 1,
      retried: 0,
      dlqed: 0,
      failed: 0,
    });
    expect(seen.at(-1)).toEqual({ value: "retry-once", attempts: 1 });
    expect(await queue.queueLength(queueKey)).toBe(0);
    expect(await queue.queueLength(`${queueKey}:dlq`)).toBe(1);
  });
});
