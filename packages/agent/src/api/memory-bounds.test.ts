/**
 * Covers the bounded in-memory helpers behind the agent API's rate-limit map,
 * conversation soft cap, log buffer, and static file cache.
 *
 * The load-bearing property of all four is that the bound actually holds. For
 * `evictOldestConversation` that turns on `updatedAt`, which is an ISO string
 * on a persisted/adapter-shaped record and can therefore be malformed —
 * `new Date("nope").getTime()` is NaN, and every comparison against NaN is
 * false, so a corrupt row can never be selected as oldest and the cap silently
 * stops evicting. Pure functions with injected IO; no runtime, no disk.
 */
import { describe, expect, it } from "vitest";

import {
  evictOldestConversation,
  getOrReadCachedFile,
  pushWithBatchEvict,
  sweepExpiredEntries,
} from "./memory-bounds.ts";

describe("sweepExpiredEntries", () => {
  it("does nothing at or below the threshold", () => {
    const map = new Map([["a", { count: 1, resetAt: 0 }]]);
    sweepExpiredEntries(map, 1_000, 1);
    expect(map.size).toBe(1);
  });

  it("evicts only entries whose reset time has passed", () => {
    const map = new Map([
      ["expired", { count: 1, resetAt: 500 }],
      ["live", { count: 1, resetAt: 5_000 }],
      ["also-expired", { count: 1, resetAt: 900 }],
    ]);
    sweepExpiredEntries(map, 1_000, 1);
    expect([...map.keys()]).toEqual(["live"]);
  });

  it("keeps an entry resetting exactly now", () => {
    const map = new Map([
      ["boundary", { count: 1, resetAt: 1_000 }],
      ["other", { count: 1, resetAt: 9_000 }],
    ]);
    sweepExpiredEntries(map, 1_000, 1);
    expect(map.has("boundary")).toBe(true);
  });
});

describe("evictOldestConversation", () => {
  const conv = (updatedAt: string) => ({ updatedAt });

  it("returns null and evicts nothing at or below the cap", () => {
    const map = new Map([["a", conv("2026-01-01T00:00:00.000Z")]]);
    expect(evictOldestConversation(map, 1)).toBeNull();
    expect(map.size).toBe(1);
  });

  it("evicts the oldest conversation by updatedAt", () => {
    const map = new Map([
      ["new", conv("2026-03-01T00:00:00.000Z")],
      ["old", conv("2026-01-01T00:00:00.000Z")],
      ["mid", conv("2026-02-01T00:00:00.000Z")],
    ]);
    expect(evictOldestConversation(map, 2)).toBe("old");
    expect([...map.keys()]).toEqual(["new", "mid"]);
  });

  it("still enforces the cap when every updatedAt is unparseable", () => {
    // NaN < Infinity is false, so no candidate is ever selected and the map
    // grows without bound despite being over cap.
    const map = new Map([
      ["a", conv("not-a-date")],
      ["b", conv("also-bad")],
      ["c", conv("")],
    ]);
    const evicted = evictOldestConversation(map, 2);
    expect(evicted).not.toBeNull();
    expect(map.size).toBe(2);
  });

  it("prefers evicting an unparseable row over a well-formed one", () => {
    const map = new Map([
      ["good-new", conv("2026-03-01T00:00:00.000Z")],
      ["corrupt", conv("garbage")],
      ["good-old", conv("2026-01-01T00:00:00.000Z")],
    ]);
    expect(evictOldestConversation(map, 2)).toBe("corrupt");
    expect(map.has("corrupt")).toBe(false);
  });

  it("evicts a conversation stored under the empty-string key", () => {
    const map = new Map([
      ["", conv("2026-01-01T00:00:00.000Z")],
      ["b", conv("2026-05-01T00:00:00.000Z")],
    ]);
    expect(evictOldestConversation(map, 1)).toBe("");
    expect(map.has("")).toBe(false);
    expect(map.size).toBe(1);
  });
});

describe("pushWithBatchEvict", () => {
  it("appends without evicting below the high-water mark", () => {
    const buffer = [1, 2];
    expect(pushWithBatchEvict(buffer, 3, 5, 2)).toBe(3);
    expect(buffer).toEqual([1, 2, 3]);
  });

  it("batch-evicts the oldest entries once the high-water mark is passed", () => {
    const buffer = [1, 2, 3];
    expect(pushWithBatchEvict(buffer, 4, 3, 2)).toBe(2);
    expect(buffer).toEqual([3, 4]);
  });

  it("keeps the buffer bounded across sustained pushes", () => {
    const buffer: number[] = [];
    for (let i = 0; i < 100; i += 1) pushWithBatchEvict(buffer, i, 10, 5);
    expect(buffer.length).toBeLessThanOrEqual(10);
    expect(buffer.at(-1)).toBe(99);
  });
});

describe("getOrReadCachedFile", () => {
  it("reads on miss and serves the cached body on the next call", () => {
    const cache = new Map();
    let reads = 0;
    const read = () => {
      reads += 1;
      return Buffer.from("body");
    };
    expect(
      getOrReadCachedFile(cache, "/a", 1, read, 10, 1_000).toString(),
    ).toBe("body");
    expect(
      getOrReadCachedFile(cache, "/a", 1, read, 10, 1_000).toString(),
    ).toBe("body");
    expect(reads).toBe(1);
  });

  it("re-reads when mtime changes", () => {
    const cache = new Map();
    let reads = 0;
    const read = () => {
      reads += 1;
      return Buffer.from("v");
    };
    getOrReadCachedFile(cache, "/a", 1, read, 10, 1_000);
    getOrReadCachedFile(cache, "/a", 2, read, 10, 1_000);
    expect(reads).toBe(2);
  });

  it("never caches a file above the size limit", () => {
    const cache = new Map();
    const read = () => Buffer.alloc(50);
    getOrReadCachedFile(cache, "/big", 1, read, 10, 10);
    expect(cache.size).toBe(0);
  });

  it("evicts the oldest inserted entry at the entry cap", () => {
    const cache = new Map();
    const read = () => Buffer.from("x");
    getOrReadCachedFile(cache, "/1", 1, read, 2, 1_000);
    getOrReadCachedFile(cache, "/2", 1, read, 2, 1_000);
    getOrReadCachedFile(cache, "/3", 1, read, 2, 1_000);
    expect(cache.size).toBe(2);
    expect(cache.has("/1")).toBe(false);
  });
});
