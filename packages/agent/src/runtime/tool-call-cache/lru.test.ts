/**
 * Unit coverage for the insertion-ordered Lru used by the in-memory
 * tool-call cache. Map iteration order is insertion order: get/set
 * delete+re-set to bump recency, and overflow shifts the oldest key
 * off the front. These tests drive the real class.
 */
import { describe, expect, it } from "vitest";
import { Lru } from "./lru.ts";

function keysOf<K, V>(lru: Lru<K, V>): K[] {
  return [...lru.entries()].map(([key]) => key);
}

describe("Lru constructor", () => {
  it("accepts a positive integer capacity", () => {
    const lru = new Lru<string, number>(1);
    expect(lru.size()).toBe(0);
  });

  it("rejects zero capacity", () => {
    expect(() => new Lru(0)).toThrow("Lru capacity must be a positive integer");
  });

  it("rejects a negative integer capacity", () => {
    expect(() => new Lru(-1)).toThrow(
      "Lru capacity must be a positive integer",
    );
  });

  it("rejects a non-integer capacity", () => {
    expect(() => new Lru(1.5)).toThrow(
      "Lru capacity must be a positive integer",
    );
  });

  it("rejects NaN and infinite capacities", () => {
    expect(() => new Lru(Number.NaN)).toThrow(
      "Lru capacity must be a positive integer",
    );
    expect(() => new Lru(Number.POSITIVE_INFINITY)).toThrow(
      "Lru capacity must be a positive integer",
    );
    expect(() => new Lru(Number.NEGATIVE_INFINITY)).toThrow(
      "Lru capacity must be a positive integer",
    );
  });
});

describe("Lru empty queue", () => {
  it("reports size 0, no entries, and undefined get", () => {
    const lru = new Lru<string, string>(3);
    expect(lru.size()).toBe(0);
    expect(keysOf(lru)).toEqual([]);
    expect(lru.get("missing")).toBeUndefined();
  });

  it("returns false when deleting a key that was never inserted", () => {
    const lru = new Lru<string, string>(3);
    expect(lru.delete("missing")).toBe(false);
    expect(lru.size()).toBe(0);
  });

  it("clear on an empty queue is a no-op", () => {
    const lru = new Lru<string, string>(3);
    lru.clear();
    expect(lru.size()).toBe(0);
    expect(keysOf(lru)).toEqual([]);
  });
});

describe("Lru single element", () => {
  it("stores, returns, and reports a single entry", () => {
    const lru = new Lru<string, number>(3);
    lru.set("only", 1);
    expect(lru.size()).toBe(1);
    expect(lru.get("only")).toBe(1);
    expect(keysOf(lru)).toEqual(["only"]);
  });

  it("deletes the only entry and leaves an empty queue", () => {
    const lru = new Lru<string, number>(3);
    lru.set("only", 1);
    expect(lru.delete("only")).toBe(true);
    expect(lru.size()).toBe(0);
    expect(lru.get("only")).toBeUndefined();
    expect(keysOf(lru)).toEqual([]);
  });

  it("overwrites the only entry in place without growing", () => {
    const lru = new Lru<string, number>(1);
    lru.set("only", 1);
    lru.set("only", 2);
    expect(lru.size()).toBe(1);
    expect(lru.get("only")).toBe(2);
    expect(keysOf(lru)).toEqual(["only"]);
  });
});

describe("Lru recency ordering", () => {
  it("iterates oldest-first in insertion order", () => {
    const lru = new Lru<string, number>(3);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    expect(keysOf(lru)).toEqual(["a", "b", "c"]);
  });

  it("get bumps the accessed key to the most-recent slot", () => {
    const lru = new Lru<string, number>(3);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    expect(lru.get("a")).toBe(1);
    expect(keysOf(lru)).toEqual(["b", "c", "a"]);
  });

  it("set on an existing key bumps recency and replaces the value", () => {
    const lru = new Lru<string, number>(3);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    lru.set("a", 10);
    expect(lru.get("a")).toBe(10);
    expect(keysOf(lru)).toEqual(["b", "c", "a"]);
  });

  it("repeated get of the same key keeps a unique most-recent slot", () => {
    const lru = new Lru<string, number>(3);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    lru.get("b");
    lru.get("b");
    expect(lru.size()).toBe(3);
    expect(keysOf(lru)).toEqual(["a", "c", "b"]);
  });
});

describe("Lru capacity overflow", () => {
  it("evicts the oldest entry when inserting past capacity", () => {
    const lru = new Lru<string, number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    expect(lru.size()).toBe(2);
    expect(lru.get("a")).toBeUndefined();
    expect(lru.get("b")).toBe(2);
    expect(lru.get("c")).toBe(3);
    expect(keysOf(lru)).toEqual(["b", "c"]);
  });

  it("evicts the current oldest after a recency bump, not the originally first key", () => {
    const lru = new Lru<string, number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    expect(lru.get("a")).toBe(1);
    lru.set("c", 3);
    expect(lru.get("b")).toBeUndefined();
    expect(keysOf(lru)).toEqual(["a", "c"]);
  });

  it("does not evict siblings when overwriting an existing key at capacity", () => {
    const lru = new Lru<string, number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("b", 20);
    expect(lru.size()).toBe(2);
    expect(lru.get("a")).toBe(1);
    expect(lru.get("b")).toBe(20);
    expect(keysOf(lru)).toEqual(["a", "b"]);
  });

  it("capacity 1 replaces the sole occupant on a new insert", () => {
    const lru = new Lru<string, number>(1);
    lru.set("a", 1);
    lru.set("b", 2);
    expect(lru.size()).toBe(1);
    expect(lru.get("a")).toBeUndefined();
    expect(lru.get("b")).toBe(2);
    expect(keysOf(lru)).toEqual(["b"]);
  });
});

describe("Lru delete, clear, and missing keys", () => {
  it("returns false when deleting a key that is not present in a filled queue", () => {
    const lru = new Lru<string, number>(3);
    lru.set("a", 1);
    lru.set("b", 2);
    expect(lru.delete("missing")).toBe(false);
    expect(lru.size()).toBe(2);
    expect(keysOf(lru)).toEqual(["a", "b"]);
  });

  it("delete of a middle key leaves remaining insertion order intact", () => {
    const lru = new Lru<string, number>(3);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    expect(lru.delete("b")).toBe(true);
    expect(keysOf(lru)).toEqual(["a", "c"]);
    lru.set("d", 4);
    expect(keysOf(lru)).toEqual(["a", "c", "d"]);
  });

  it("clear drops every entry", () => {
    const lru = new Lru<string, number>(3);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.clear();
    expect(lru.size()).toBe(0);
    expect(lru.get("a")).toBeUndefined();
    expect(keysOf(lru)).toEqual([]);
  });

  it("get of a missing key does not change insertion order", () => {
    const lru = new Lru<string, number>(3);
    lru.set("a", 1);
    lru.set("b", 2);
    expect(lru.get("missing")).toBeUndefined();
    expect(keysOf(lru)).toEqual(["a", "b"]);
  });
});

describe("Lru stored values and keys", () => {
  it("round-trips falsy values that are not undefined", () => {
    const lru = new Lru<string, unknown>(4);
    lru.set("zero", 0);
    lru.set("empty", "");
    lru.set("false", false);
    lru.set("null", null);
    expect(lru.get("zero")).toBe(0);
    expect(lru.get("empty")).toBe("");
    expect(lru.get("false")).toBe(false);
    expect(lru.get("null")).toBeNull();
    expect(lru.size()).toBe(4);
  });

  it("treats a stored undefined as a miss and does not bump recency", () => {
    const lru = new Lru<string, number | undefined>(3);
    lru.set("a", 1);
    lru.set("ghost", undefined);
    lru.set("b", 2);
    expect(lru.size()).toBe(3);
    expect(lru.get("ghost")).toBeUndefined();
    expect(keysOf(lru)).toEqual(["a", "ghost", "b"]);
  });

  it("uses object identity for keys", () => {
    const lru = new Lru<{ id: number }, string>(2);
    const first = { id: 1 };
    const sameShape = { id: 1 };
    lru.set(first, "kept");
    lru.set(sameShape, "other");
    expect(lru.size()).toBe(2);
    expect(lru.get(first)).toBe("kept");
    expect(lru.get(sameShape)).toBe("other");
    expect(lru.get({ id: 1 })).toBeUndefined();
  });
});
