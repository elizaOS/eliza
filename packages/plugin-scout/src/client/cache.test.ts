import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ScoutCache } from "./cache.js";

describe("ScoutCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores and retrieves values", () => {
    const cache = new ScoutCache({ ttlMinutes: 5, maxEntries: 10 });
    cache.set("key1", { data: "hello" });
    expect(cache.get("key1")).toEqual({ data: "hello" });
  });

  it("returns undefined for missing keys", () => {
    const cache = new ScoutCache({ ttlMinutes: 5, maxEntries: 10 });
    expect(cache.get("nonexistent")).toBeUndefined();
  });

  it("expires entries after TTL", () => {
    const cache = new ScoutCache({ ttlMinutes: 5, maxEntries: 10 });
    cache.set("key1", "value1");

    // Advance time past TTL (5 minutes = 300000ms)
    vi.advanceTimersByTime(300001);

    expect(cache.get("key1")).toBeUndefined();
  });

  it("returns value before TTL expires", () => {
    const cache = new ScoutCache({ ttlMinutes: 5, maxEntries: 10 });
    cache.set("key1", "value1");

    vi.advanceTimersByTime(299999);

    expect(cache.get("key1")).toBe("value1");
  });

  it("evicts oldest entry when at capacity", () => {
    const cache = new ScoutCache({ ttlMinutes: 5, maxEntries: 3 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);

    // Cache is full, adding 'd' should evict 'a'
    cache.set("d", 4);

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("d")).toBe(4);
    expect(cache.size).toBe(3);
  });

  it("tracks size correctly", () => {
    const cache = new ScoutCache({ ttlMinutes: 5, maxEntries: 10 });
    expect(cache.size).toBe(0);
    cache.set("a", 1);
    expect(cache.size).toBe(1);
    cache.set("b", 2);
    expect(cache.size).toBe(2);
  });

  it("has() returns true for existing keys", () => {
    const cache = new ScoutCache({ ttlMinutes: 5, maxEntries: 10 });
    cache.set("key1", "value1");
    expect(cache.has("key1")).toBe(true);
    expect(cache.has("key2")).toBe(false);
  });

  it("has() returns false for expired keys", () => {
    const cache = new ScoutCache({ ttlMinutes: 1, maxEntries: 10 });
    cache.set("key1", "value1");
    vi.advanceTimersByTime(60001);
    expect(cache.has("key1")).toBe(false);
  });

  it("delete() removes an entry", () => {
    const cache = new ScoutCache({ ttlMinutes: 5, maxEntries: 10 });
    cache.set("key1", "value1");
    cache.delete("key1");
    expect(cache.get("key1")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("clear() removes all entries", () => {
    const cache = new ScoutCache({ ttlMinutes: 5, maxEntries: 10 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  it("overwrites existing keys", () => {
    const cache = new ScoutCache({ ttlMinutes: 5, maxEntries: 10 });
    cache.set("key1", "old");
    cache.set("key1", "new");
    expect(cache.get("key1")).toBe("new");
    expect(cache.size).toBe(1);
  });

  it("handles maxEntries of 1", () => {
    const cache = new ScoutCache({ ttlMinutes: 5, maxEntries: 1 });
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.size).toBe(1);
  });
});