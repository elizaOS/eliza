/**
 * Regression coverage for the bounded-view LRU and module-cache eviction
 * planners when `lastActiveAt` / `lastUsedAt` carry NaN or non-finite values.
 * Deterministic, and drives the exported planners directly — no mocks.
 */

import { describe, expect, it } from "vitest";
import {
  type ModuleCacheEntryLike,
  planModuleCacheEvictions,
  selectLruEvictions,
} from "./bounded-view-lru.js";

describe("selectLruEvictions with non-finite lastActiveAt", () => {
  it("treats NaN and Infinity timestamps as oldest instead of poisoning the sort", () => {
    const retainedIds = ["view-a", "view-b", "view-c", "view-d", "view-e"];
    const exempt = new Set<string>(["view-a"]);
    const lastActiveAt = new Map<string, number>([
      ["view-b", Number.NaN],
      ["view-c", 1000],
      ["view-d", 2000],
      ["view-e", Number.POSITIVE_INFINITY],
    ]);

    const evictions = selectLruEvictions(retainedIds, lastActiveAt, 2, exempt);

    // Both non-finite timestamps collapse to 0, then tie-break by id.
    expect(evictions).toEqual(["view-b", "view-e"]);
  });

  it("keeps an Infinity timestamp from masquerading as the most recent view", () => {
    const evictions = selectLruEvictions(
      ["stale", "fresh"],
      new Map<string, number>([
        ["stale", Number.POSITIVE_INFINITY],
        ["fresh", 5000],
      ]),
      1,
      new Set<string>(),
    );

    expect(evictions).toEqual(["stale"]);
  });
});

describe("planModuleCacheEvictions with non-finite lastUsedAt", () => {
  interface TestEntry extends ModuleCacheEntryLike {
    id: string;
  }

  it("TTL-evicts an idle entry whose lastUsedAt is NaN", () => {
    const entries: TestEntry[] = [
      { id: "mod-nan", refCount: 0, lastUsedAt: Number.NaN },
      { id: "mod-fresh", refCount: 0, lastUsedAt: 9500 },
      { id: "mod-active", refCount: 1, lastUsedAt: 1000 },
    ];

    const plan = planModuleCacheEvictions(entries, {
      now: 10_000,
      ttlMs: 3000,
      maxEntries: 10,
      force: false,
      totalSize: entries.length,
    });

    expect(
      plan.map((p) => ({ id: (p.entry as TestEntry).id, phase: p.phase })),
    ).toEqual([{ id: "mod-nan", phase: "ttl" }]);
  });

  it("orders a NaN-timestamped entry ahead of live ones in the LRU phase", () => {
    const entries: TestEntry[] = [
      { id: "mod-recent", refCount: 0, lastUsedAt: 9900 },
      { id: "mod-nan", refCount: 0, lastUsedAt: Number.NaN },
    ];

    const plan = planModuleCacheEvictions(entries, {
      now: 10_000,
      ttlMs: Number.POSITIVE_INFINITY,
      maxEntries: 1,
      force: false,
      totalSize: entries.length,
    });

    expect(
      plan.map((p) => ({ id: (p.entry as TestEntry).id, phase: p.phase })),
    ).toEqual([{ id: "mod-nan", phase: "lru" }]);
  });
});
