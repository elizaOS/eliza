/**
 * Unit coverage for the resource cache's equality gate: an equal payload keeps
 * the snapshot reference so useSyncExternalStore consumers do not re-render
 * (#9141). In-memory store, no harness.
 */
import { describe, expect, it, vi } from "vitest";
import { getCached, invalidate, setCached, subscribe } from "./resource-cache";

// #9141: a poll that returns an unchanged payload must not churn the cache
// snapshot — useSyncExternalStore compares by reference, so a fresh-but-equal
// entry would re-render every consumer (the router + tab bar every 30s, etc.).

describe("resource-cache equality gate (#9141)", () => {
  it("skips notify + keeps the snapshot reference when an equal payload is set", () => {
    const key = "test:eq:unchanged";
    invalidate(key);
    setCached(key, { a: 1, list: [1, 2, 3] });
    const snap1 = getCached(key);
    const sub = vi.fn();
    const unsub = subscribe(key, sub);

    // A deep-equal payload arriving as a fresh object reference (a poll result).
    setCached(key, { a: 1, list: [1, 2, 3] });

    expect(sub).not.toHaveBeenCalled();
    expect(getCached(key)).toBe(snap1); // identical reference → no re-render
    unsub();
    invalidate(key);
  });

  it("notifies + replaces the snapshot when the payload actually changes", () => {
    const key = "test:eq:changed";
    invalidate(key);
    setCached(key, { a: 1 });
    const snap1 = getCached(key);
    const sub = vi.fn();
    const unsub = subscribe(key, sub);

    setCached(key, { a: 2 });

    expect(sub).toHaveBeenCalledTimes(1);
    expect(getCached(key)).not.toBe(snap1);
    expect(getCached(key)?.data).toEqual({ a: 2 });
    unsub();
    invalidate(key);
  });

  it("treats array order/length changes as a real update", () => {
    const key = "test:eq:array";
    invalidate(key);
    setCached(key, [1, 2, 3]);
    const sub = vi.fn();
    const unsub = subscribe(key, sub);
    setCached(key, [3, 2, 1]); // same members, different order → not equal
    expect(sub).toHaveBeenCalledTimes(1);
    unsub();
    invalidate(key);
  });

  it("refreshes freshness in place on an unchanged payload (no backwards time)", () => {
    const key = "test:eq:freshness";
    invalidate(key);
    setCached(key, [1, 2]);
    const before = getCached(key)?.updatedAt ?? 0;
    setCached(key, [1, 2]);
    const after = getCached(key)?.updatedAt ?? 0;
    expect(after).toBeGreaterThanOrEqual(before);
    invalidate(key);
  });
});
