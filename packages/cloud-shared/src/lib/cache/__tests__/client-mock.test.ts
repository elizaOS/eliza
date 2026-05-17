import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const PREV_MOCK = process.env.MOCK_REDIS;

beforeAll(() => {
  process.env.MOCK_REDIS = "1";
});

afterAll(() => {
  if (PREV_MOCK === undefined) {
    delete process.env.MOCK_REDIS;
  } else {
    process.env.MOCK_REDIS = PREV_MOCK;
  }
});

describe("CacheClient (MOCK_REDIS=1)", () => {
  test("set + get round-trip via in-memory adapter", async () => {
    const { CacheClient } = await import("../client");
    const cache = new CacheClient();

    expect(cache.isAvailable()).toBe(true);

    await cache.set("user:1", { name: "alice" }, 60);
    const value = await cache.get<{ name: string }>("user:1");
    expect(value).toEqual({ name: "alice" });

    // expire on an existing key should not throw
    await cache.expire("user:1", 30);

    await cache.del("user:1");
    expect(await cache.get("user:1")).toBeNull();
  });
});
