import { describe, expect, test } from "bun:test";
import { InMemoryLRUCache } from "./in-memory-lru-cache";

describe("InMemoryLRUCache replacement", () => {
  test("a warm scope refresh at production capacity keeps every other entry", () => {
    // resolveSharedAgent uses capacity 1,000/TTL 15s and performs get+set on a
    // validated warm hit. The refresh must not evict 250 unrelated warm scopes.
    const cache = new InMemoryLRUCache<number>(1_000, 15_000);
    for (let key = 0; key < 1_000; key++) cache.set(String(key), key);
    expect(cache.get("999")).toBe(999);
    cache.set("999", 1_999);
    for (let key = 0; key < 999; key++) expect(cache.get(String(key))).toBe(key);
    expect(cache.get("999")).toBe(1_999);
  });

  test("replacement makes an entry recent before the next capacity eviction", () => {
    const cache = new InMemoryLRUCache<number>(4, 60_000);
    cache.set("a", 0);
    cache.set("b", 0);
    cache.set("c", 0);
    cache.set("a", 1);
    cache.set("d", 0);
    cache.set("e", 0);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeNull();
    expect(cache.get("c")).toBe(0);
    expect(cache.get("d")).toBe(0);
    expect(cache.get("e")).toBe(0);
  });

  test("a new key still evicts the least-recent quarter at capacity", () => {
    const cache = new InMemoryLRUCache<number>(8, 60_000);
    for (let key = 0; key < 8; key++) cache.set(String(key), key);
    expect(cache.get("0")).toBe(0);
    cache.set("8", 8);
    expect(cache.get("0")).toBe(0);
    expect(cache.get("1")).toBeNull();
    expect(cache.get("2")).toBeNull();
    for (let key = 3; key <= 8; key++) expect(cache.get(String(key))).toBe(key);
  });
});
