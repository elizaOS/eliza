/**
 * Unit tests for MemoryCacheAdapter verifying Redis-compliant incr behavior,
 * TTL preservation, and non-integer error handling.
 */
import { describe, expect, it } from "vitest";
import { MemoryCacheAdapter } from "./memory-cache-adapter";

describe("MemoryCacheAdapter", () => {
  it("increments unset and existing integer keys", async () => {
    const cache = new MemoryCacheAdapter();
    expect(await cache.incr("counter")).toBe(1);
    expect(await cache.incr("counter")).toBe(2);
    expect(await cache.get("counter")).toBe("2");
  });

  it("preserves key TTL when calling incr", async () => {
    const cache = new MemoryCacheAdapter();
    await cache.setex("expiring-counter", 60, "10");

    const ttlBefore = await cache.pttl("expiring-counter");
    expect(ttlBefore).toBeGreaterThan(0);

    const next = await cache.incr("expiring-counter");
    expect(next).toBe(11);

    const ttlAfter = await cache.pttl("expiring-counter");
    expect(ttlAfter).toBeGreaterThan(0);
    expect(ttlAfter).toBeLessThanOrEqual(ttlBefore!);
  });

  it("throws for non-integer or malformed values on incr", async () => {
    const cache = new MemoryCacheAdapter();
    await cache.set("text", "hello");
    await expect(cache.incr("text")).rejects.toThrow("ERR value is not an integer or out of range");

    await cache.set("prefixed", "10abc");
    await expect(cache.incr("prefixed")).rejects.toThrow(
      "ERR value is not an integer or out of range",
    );
  });
});
