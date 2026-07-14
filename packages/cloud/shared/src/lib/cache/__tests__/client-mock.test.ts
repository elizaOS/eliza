/** Exercises CacheClient against the in-memory mock backend (MOCK_REDIS=1); no real Redis. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const PREV_MOCK = process.env.MOCK_REDIS;
const PREV_CACHE_ENABLED = process.env.CACHE_ENABLED;

beforeAll(() => {
  process.env.MOCK_REDIS = "1";
  process.env.CACHE_ENABLED = "true";
});

afterAll(() => {
  if (PREV_MOCK === undefined) {
    delete process.env.MOCK_REDIS;
  } else {
    process.env.MOCK_REDIS = PREV_MOCK;
  }

  if (PREV_CACHE_ENABLED === undefined) {
    delete process.env.CACHE_ENABLED;
  } else {
    process.env.CACHE_ENABLED = PREV_CACHE_ENABLED;
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

  test("explicit outcomes distinguish hit, miss, invalid write, and unavailable backend", async () => {
    const { CacheClient } = await import("../client");
    const cache = new CacheClient();

    expect(await cache.getWithOutcome("iac:auth:bounded:v1")).toEqual({
      kind: "miss",
      backend: "memory",
    });
    expect(await cache.setWithOutcome("iac:auth:bounded:v1", { ok: true }, 60)).toEqual({
      kind: "written",
      backend: "memory",
    });
    expect(await cache.getWithOutcome("iac:auth:bounded:v1")).toEqual({
      kind: "hit",
      value: { ok: true },
      backend: "memory",
    });
    expect(await cache.setWithOutcome("iac:auth:invalid:v1", null, 60)).toEqual({
      kind: "invalid",
      backend: "memory",
    });

    process.env.CACHE_ENABLED = "false";
    try {
      const disabled = new CacheClient();
      expect(await disabled.getWithOutcome("iac:auth:bounded:v1")).toEqual({
        kind: "unavailable",
        backend: "none",
      });
    } finally {
      process.env.CACHE_ENABLED = "true";
    }
  });
});
