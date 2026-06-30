/**
 * Pure module-cache eviction planner (#10196 item 3 — "the eviction policy is
 * not centralized or independently testable"). `retained-lazy.tsx` and
 * `components/views/DynamicViewLoader.tsx` previously each carried a byte-
 * identical TTL-sweep + LRU-cap loop; both now call `planModuleCacheEvictions`,
 * so this is the single place the policy is asserted. The cases pin the exact
 * behavior the duplicated loops had: idle-only, oldest-first, TTL-then-LRU,
 * `force` evicts all idle, and active (`refCount > 0`) entries are never chosen.
 */
import { describe, expect, it } from "vitest";
import {
  type ModuleCacheEntryLike,
  type ModuleCacheEvictionPhase,
  planModuleCacheEvictions,
} from "./bounded-view-lru";

interface TestEntry extends ModuleCacheEntryLike {
  id: string;
}

const e = (id: string, lastUsedAt: number, refCount = 0): TestEntry => ({
  id,
  lastUsedAt,
  refCount,
});

/** Flatten a plan to `[id, phase]` pairs for order-sensitive assertions. */
const pairs = (
  plan: { entry: TestEntry; phase: ModuleCacheEvictionPhase }[],
): [string, ModuleCacheEvictionPhase][] =>
  plan.map(({ entry, phase }) => [entry.id, phase]);

const NOW = 1_000_000;
const TTL = 5 * 60_000;

describe("planModuleCacheEvictions", () => {
  it("evicts nothing when every idle entry is fresh and within the cap", () => {
    const entries = [e("a", NOW - 1_000), e("b", NOW - 2_000)];
    const plan = planModuleCacheEvictions(entries, {
      now: NOW,
      ttlMs: TTL,
      maxEntries: 6,
      force: false,
      totalSize: entries.length,
    });
    expect(plan).toEqual([]);
  });

  it("TTL-evicts only idle entries past the TTL, oldest first", () => {
    const fresh = e("fresh", NOW - 1_000);
    const stale1 = e("stale1", NOW - (TTL + 10_000));
    const stale2 = e("stale2", NOW - (TTL + 1)); // just over the line, newer than stale1
    const plan = planModuleCacheEvictions([fresh, stale2, stale1], {
      now: NOW,
      ttlMs: TTL,
      maxEntries: 6,
      force: false,
      totalSize: 3,
    });
    // oldest-first: stale1 (older) before stale2; fresh is untouched.
    expect(pairs(plan)).toEqual([
      ["stale1", "ttl"],
      ["stale2", "ttl"],
    ]);
  });

  it("never selects an active (refCount > 0) entry, even when stale", () => {
    const pinnedStale = e("pinned", NOW - 10 * TTL, 2);
    const idleStale = e("idle", NOW - 10 * TTL, 0);
    const plan = planModuleCacheEvictions([pinnedStale, idleStale], {
      now: NOW,
      ttlMs: TTL,
      maxEntries: 0,
      force: false,
      totalSize: 2,
    });
    expect(pairs(plan)).toEqual([["idle", "ttl"]]);
  });

  it("LRU-evicts the oldest idle entries down to the cap when all are fresh", () => {
    // 4 fresh idle entries, cap of 2 → evict the 2 oldest as LRU.
    const entries = [
      e("newest", NOW - 1_000),
      e("older", NOW - 3_000),
      e("oldest", NOW - 4_000),
      e("mid", NOW - 2_000),
    ];
    const plan = planModuleCacheEvictions(entries, {
      now: NOW,
      ttlMs: TTL,
      maxEntries: 2,
      force: false,
      totalSize: 4,
    });
    expect(pairs(plan)).toEqual([
      ["oldest", "lru"],
      ["older", "lru"],
    ]);
  });

  it("applies the TTL sweep first, then LRU on the survivors, with no double-eviction", () => {
    // stale (past TTL) → ttl; remaining 3 fresh idle with cap 1 → 2 LRU evictions.
    const entries = [
      e("stale", NOW - (TTL + 5_000)),
      e("f-newest", NOW - 1_000),
      e("f-oldest", NOW - 3_500),
      e("f-mid", NOW - 2_000),
    ];
    const plan = planModuleCacheEvictions(entries, {
      now: NOW,
      ttlMs: TTL,
      maxEntries: 1,
      force: false,
      totalSize: 4,
    });
    expect(pairs(plan)).toEqual([
      ["stale", "ttl"],
      ["f-oldest", "lru"],
      ["f-mid", "lru"],
    ]);
    // every entry appears at most once
    const ids = plan.map((p) => p.entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("force-evicts every idle entry as TTL, regardless of freshness", () => {
    const entries = [e("a", NOW), e("b", NOW - 1), e("pinned", NOW, 1)];
    const plan = planModuleCacheEvictions(entries, {
      now: NOW,
      ttlMs: 0,
      maxEntries: 0,
      force: true,
      totalSize: 3,
    });
    // both idle entries evicted (oldest-first), the pinned one survives
    expect(pairs(plan)).toEqual([
      ["b", "ttl"],
      ["a", "ttl"],
    ]);
  });

  it("measures the cap against post-TTL size, not the original size", () => {
    // 5 entries, 3 stale (past TTL), cap 3. After the 3 TTL evictions only 2
    // remain (≤ cap) so the LRU phase must add nothing.
    const entries = [
      e("s1", NOW - (TTL + 1)),
      e("s2", NOW - (TTL + 2)),
      e("s3", NOW - (TTL + 3)),
      e("fresh1", NOW - 1_000),
      e("fresh2", NOW - 2_000),
    ];
    const plan = planModuleCacheEvictions(entries, {
      now: NOW,
      ttlMs: TTL,
      maxEntries: 3,
      force: false,
      totalSize: 5,
    });
    expect(plan.every((p) => p.phase === "ttl")).toBe(true);
    expect(plan).toHaveLength(3);
  });

  it("counts active entries toward the cap but never evicts them", () => {
    // 2 active + 2 idle, cap 1. Active entries occupy size but can't be evicted,
    // so both idle are LRU-evicted (size 4 → 2, still > cap, but nothing idle left).
    const entries = [
      e("act1", NOW, 1),
      e("act2", NOW, 1),
      e("idle-old", NOW - 3_000),
      e("idle-new", NOW - 1_000),
    ];
    const plan = planModuleCacheEvictions(entries, {
      now: NOW,
      ttlMs: TTL,
      maxEntries: 1,
      force: false,
      totalSize: 4,
    });
    expect(pairs(plan)).toEqual([
      ["idle-old", "lru"],
      ["idle-new", "lru"],
    ]);
  });

  it("returns an empty plan for an empty cache", () => {
    expect(
      planModuleCacheEvictions<TestEntry>([], {
        now: NOW,
        ttlMs: TTL,
        maxEntries: 0,
        force: true,
        totalSize: 0,
      }),
    ).toEqual([]);
  });
});
