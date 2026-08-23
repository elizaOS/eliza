import { describe, expect, it } from "vitest";
import {
  evictOldestConversation,
  pushWithBatchEvict,
  sweepExpiredEntries,
} from "./memory-bounds.ts";

describe("sweepExpiredEntries", () => {
  it("does nothing below the threshold", () => {
    const map = new Map([["a", { count: 1, resetAt: 100 }]]);
    sweepExpiredEntries(map, 200, 5);
    expect(map.size).toBe(1);
  });

  it("evicts expired entries above the threshold", () => {
    const map = new Map([
      ["a", { count: 1, resetAt: 100 }],
      ["b", { count: 1, resetAt: 500 }],
    ]);
    sweepExpiredEntries(map, 300, 1);
    expect(map.has("a")).toBe(false);
    expect(map.has("b")).toBe(true);
  });

  it("keeps unexpired entries even above threshold", () => {
    const map = new Map([
      ["a", { count: 1, resetAt: 500 }],
      ["b", { count: 1, resetAt: 600 }],
    ]);
    sweepExpiredEntries(map, 300, 1);
    expect(map.size).toBe(2);
  });
});

describe("evictOldestConversation", () => {
  it("returns null under the cap", () => {
    const map = new Map([["a", { updatedAt: "2026-01-01T00:00:00Z" }]]);
    expect(evictOldestConversation(map, 5)).toBeNull();
  });

  it("evicts the oldest conversation over the cap", () => {
    const map = new Map([
      ["old", { updatedAt: "2026-01-01T00:00:00Z" }],
      ["new", { updatedAt: "2026-02-01T00:00:00Z" }],
    ]);
    expect(evictOldestConversation(map, 1)).toBe("old");
    expect(map.has("old")).toBe(false);
  });

  it("deletes and returns the evicted key", () => {
    const map = new Map([
      ["x", { updatedAt: "2026-03-01T00:00:00Z" }],
      ["y", { updatedAt: "2026-01-01T00:00:00Z" }],
    ]);
    const evicted = evictOldestConversation(map, 1);
    expect(evicted).toBe("y");
    expect(map.size).toBe(1);
  });
});

describe("pushWithBatchEvict", () => {
  it("appends under the high-water mark", () => {
    const buffer: number[] = [1, 2];
    expect(pushWithBatchEvict(buffer, 3, 5, 2)).toBe(3);
    expect(buffer).toEqual([1, 2, 3]);
  });

  it("batch-evicts oldest entries over the high-water mark", () => {
    const buffer: number[] = [1, 2, 3, 4];
    expect(pushWithBatchEvict(buffer, 5, 4, 2)).toBe(3);
    expect(buffer).toEqual([3, 4, 5]);
  });
});
