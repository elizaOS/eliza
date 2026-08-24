/**
 * Behavioral coverage for the generic in-memory LRU cache with TTL expiry.
 *
 * The eviction contract (at capacity):
 * 1. expired entries are evicted first,
 * 2. if still over capacity, the oldest entries (by insertion order) are
 *    evicted down to 75% of maxSize,
 * 3. reads refresh recency (true LRU).
 */
import { describe, expect, test } from "bun:test";
import { InMemoryLRUCache } from "../in-memory-lru-cache";

describe("InMemoryLRUCache", () => {
  test("returns null for missing keys", () => {
    const cache = new InMemoryLRUCache<string>(3, 60_000);
    expect(cache.get("missing")).toBeNull();
  });

  test("round-trips set/get", () => {
    const cache = new InMemoryLRUCache<number>(3, 60_000);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBe(2);
  });

  test("overwrites an existing key in place", () => {
    const cache = new InMemoryLRUCache<string>(3, 60_000);
    cache.set("a", "v1");
    cache.set("a", "v2");
    expect(cache.get("a")).toBe("v2");
  });

  test("expires entries once the TTL elapses", async () => {
    const cache = new InMemoryLRUCache<string>(10, 30);
    cache.set("a", "v");
    expect(cache.get("a")).toBe("v");
    await Bun.sleep(60);
    expect(cache.get("a")).toBeNull();
  });

  test("evicts the least-recently-inserted entry at capacity", () => {
    const cache = new InMemoryLRUCache<string>(2, 60_000);
    cache.set("a", "v-a");
    cache.set("b", "v-b");
    cache.set("c", "v-c"); // at capacity: oldest (a) is evicted
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBe("v-b");
    expect(cache.get("c")).toBe("v-c");
  });

  test("reads refresh recency so hot entries survive eviction", () => {
    const cache = new InMemoryLRUCache<string>(2, 60_000);
    cache.set("a", "v-a");
    cache.set("b", "v-b");
    expect(cache.get("a")).toBe("v-a"); // a is now most-recent
    cache.set("c", "v-c"); // oldest by recency is now b
    expect(cache.get("b")).toBeNull();
    expect(cache.get("a")).toBe("v-a");
    expect(cache.get("c")).toBe("v-c");
  });

  test("evicts expired entries before making room", async () => {
    const cache = new InMemoryLRUCache<string>(2, 20);
    cache.set("a", "v-a");
    cache.set("b", "v-b");
    await Bun.sleep(40); // both entries now expired
    cache.set("c", "v-c"); // eviction clears the expired entries first
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBeNull();
    expect(cache.get("c")).toBe("v-c");
  });

  test("trims toward 75% of capacity instead of evicting a single slot", () => {
    const cache = new InMemoryLRUCache<string>(4, 60_000);
    for (const k of ["a", "b", "c", "d"]) cache.set(k, `v-${k}`);
    cache.set("e", "v-e"); // at capacity: trim 4 -> 3, then insert e
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBe("v-b");
    expect(cache.get("c")).toBe("v-c");
    expect(cache.get("d")).toBe("v-d");
    expect(cache.get("e")).toBe("v-e");
  });

  test("delete removes a single key", () => {
    const cache = new InMemoryLRUCache<string>(3, 60_000);
    cache.set("a", "v-a");
    cache.set("b", "v-b");
    cache.delete("a");
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBe("v-b");
  });

  test("deleteByPrefix removes every key sharing the prefix", () => {
    const cache = new InMemoryLRUCache<string>(10, 60_000);
    cache.set("a:1", "v1");
    cache.set("a:2", "v2");
    cache.set("b:1", "v3");
    cache.deleteByPrefix("a:");
    expect(cache.get("a:1")).toBeNull();
    expect(cache.get("a:2")).toBeNull();
    expect(cache.get("b:1")).toBe("v3");
  });

  test("clear empties the cache", () => {
    const cache = new InMemoryLRUCache<string>(3, 60_000);
    cache.set("a", "v-a");
    cache.set("b", "v-b");
    cache.clear();
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBeNull();
  });
});
