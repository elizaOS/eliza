import { afterEach, describe, expect, test } from "bun:test";
import { CacheClient } from "@/lib/cache/client";

const originalEnv = { ...process.env };

function resetEnv() {
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

function configureCacheEnv(backend: string) {
  process.env.CACHE_ENABLED = "true";
  process.env.CACHE_BACKEND = backend;
  process.env.NODE_ENV = "test";
  process.env.ENVIRONMENT = "test";
  delete process.env.REDIS_URL;
  delete process.env.KV_URL;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

afterEach(resetEnv);

describe("CacheClient adapters", () => {
  test("uses Wadis as the embedded local Redis-compatible backend", async () => {
    configureCacheEnv("wadis");

    const client = new CacheClient();

    expect(client.isAvailable()).toBe(true);

    await client.set("wadis:value", "hello", 60);
    const value = await client.get<string>("wadis:value");
    expect(value).toBe("hello");

    const firstClaim = await client.setIfNotExists("wadis:nonce", "used", 60_000);
    const secondClaim = await client.setIfNotExists("wadis:nonce", "used", 60_000);
    const consumedNonce = await client.getAndDelete<string>("wadis:nonce");
    const deletedNonce = await client.get("wadis:nonce");
    expect(firstClaim).toBe(true);
    expect(secondClaim).toBe(false);
    expect(consumedNonce).toBe("used");
    expect(deletedNonce).toBeNull();

    expect(await client.popQueueTail("wadis:queue")).toBeNull();
    expect(await client.pushQueueHead("wadis:queue", "first")).toBe(1);
    expect(await client.pushQueueHead("wadis:queue", "second")).toBe(2);
    expect(await client.getQueueLength("wadis:queue")).toBe(2);
    expect(await client.popQueueTail("wadis:queue")).toBe("first");
    expect(await client.popQueueTail("wadis:queue")).toBe("second");
    expect(await client.getQueueLength("wadis:queue")).toBe(0);
  });

  test("auto backend falls back to Wadis when no Redis credentials are set", async () => {
    configureCacheEnv("auto");

    const client = new CacheClient();

    expect(client.isAvailable()).toBe(true);

    await client.set("auto:value", "hi", 60);
    const value = await client.get<string>("auto:value");
    expect(value).toBe("hi");
  });
});
