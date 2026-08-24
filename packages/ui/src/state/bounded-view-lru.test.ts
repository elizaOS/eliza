/**
 * Covers the shared sizing + eviction policy behind every bounded view cache in
 * the shell.
 *
 * Two things are load-bearing. The caps must tighten under EITHER a static
 * low-memory device hint OR live heap pressure — an engine without either hint
 * must keep the larger caps rather than defaulting to the conservative tier.
 * And both eviction planners must never select a pinned or active entry: the
 * LRU selector excludes exempt ids, and the module planner never evicts an
 * entry with a live `refCount`, because doing so would tear a module out from
 * under a mounted view.
 *
 * Pure functions with injected clocks; the two capability hints are installed
 * as globals and removed afterwards.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_KEEP_ALIVE_MAX_VIEWS,
  DEFAULT_KEEP_ALIVE_TTL_MS,
  DEFAULT_RETAINED_MODULE_MAX_ENTRIES,
  DEFAULT_RETAINED_MODULE_TTL_MS,
  getHeapPressureRatio,
  getKeepAliveMaxViews,
  getKeepAliveTtlMs,
  getRetainedModuleMaxEntries,
  getRetainedModuleTtlMs,
  HEAP_PRESSURE_RATIO,
  isHeapUnderPressure,
  isLowMemoryDevice,
  isUnderMemoryPressure,
  LOW_MEMORY_DEVICE_GB,
  LOW_MEMORY_KEEP_ALIVE_MAX_VIEWS,
  LOW_MEMORY_KEEP_ALIVE_TTL_MS,
  LOW_MEMORY_RETAINED_MODULE_MAX_ENTRIES,
  LOW_MEMORY_RETAINED_MODULE_TTL_MS,
  type ModuleCacheEntryLike,
  planModuleCacheEvictions,
  resolveDeviceMemoryGb,
  resolveHeapUsage,
  selectLruEvictions,
} from "./bounded-view-lru.ts";

const g = globalThis as Record<string, unknown>;

// `navigator` is a getter-only global in Node, so it has to be redefined
// rather than assigned, and restored from its original descriptor afterwards.
const originalNavigator = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator",
);

function setDeviceMemory(value: unknown): void {
  Object.defineProperty(globalThis, "navigator", {
    value: { deviceMemory: value },
    configurable: true,
    writable: true,
  });
}

function setHeap(used: unknown, limit: unknown): void {
  (performance as unknown as Record<string, unknown>).memory = {
    usedJSHeapSize: used,
    jsHeapSizeLimit: limit,
  };
}

afterEach(() => {
  if (originalNavigator) {
    Object.defineProperty(globalThis, "navigator", originalNavigator);
  } else {
    delete g.navigator;
  }
  delete (performance as unknown as Record<string, unknown>).memory;
});

describe("device memory hint", () => {
  it("reports null when the hint is absent or unusable", () => {
    setDeviceMemory(undefined);
    expect(resolveDeviceMemoryGb()).toBeNull();
    setDeviceMemory("8");
    expect(resolveDeviceMemoryGb()).toBeNull();
    setDeviceMemory(Number.NaN);
    expect(resolveDeviceMemoryGb()).toBeNull();
  });

  it("treats an absent hint as NOT low memory, keeping the larger caps", () => {
    setDeviceMemory(undefined);
    expect(isLowMemoryDevice()).toBe(false);
  });

  it("is inclusive at the documented threshold", () => {
    setDeviceMemory(LOW_MEMORY_DEVICE_GB);
    expect(isLowMemoryDevice()).toBe(true);
    setDeviceMemory(LOW_MEMORY_DEVICE_GB + 1);
    expect(isLowMemoryDevice()).toBe(false);
  });
});

describe("heap pressure hint", () => {
  it("reports null when performance.memory is absent or malformed", () => {
    expect(resolveHeapUsage()).toBeNull();
    setHeap("100", 1000);
    expect(resolveHeapUsage()).toBeNull();
    setHeap(100, 0);
    expect(resolveHeapUsage()).toBeNull();
    setHeap(-1, 1000);
    expect(resolveHeapUsage()).toBeNull();
    setHeap(Number.NaN, 1000);
    expect(resolveHeapUsage()).toBeNull();
  });

  it("computes the fill ratio and is inclusive at the threshold", () => {
    setHeap(500, 1000);
    expect(getHeapPressureRatio()).toBe(0.5);
    expect(isHeapUnderPressure()).toBe(false);
    setHeap(HEAP_PRESSURE_RATIO * 1000, 1000);
    expect(isHeapUnderPressure()).toBe(true);
  });

  it("reports no pressure when the hint is missing", () => {
    expect(getHeapPressureRatio()).toBeNull();
    expect(isHeapUnderPressure()).toBe(false);
  });
});

describe("tier selection", () => {
  it("uses the default tier when neither hint indicates pressure", () => {
    setDeviceMemory(16);
    setHeap(100, 1000);
    expect(isUnderMemoryPressure()).toBe(false);
    expect(getRetainedModuleTtlMs()).toBe(DEFAULT_RETAINED_MODULE_TTL_MS);
    expect(getRetainedModuleMaxEntries()).toBe(
      DEFAULT_RETAINED_MODULE_MAX_ENTRIES,
    );
    expect(getKeepAliveMaxViews()).toBe(DEFAULT_KEEP_ALIVE_MAX_VIEWS);
    expect(getKeepAliveTtlMs()).toBe(DEFAULT_KEEP_ALIVE_TTL_MS);
  });

  it("tightens on the device hint alone", () => {
    setDeviceMemory(2);
    expect(isUnderMemoryPressure()).toBe(true);
    expect(getRetainedModuleMaxEntries()).toBe(
      LOW_MEMORY_RETAINED_MODULE_MAX_ENTRIES,
    );
    expect(getKeepAliveMaxViews()).toBe(LOW_MEMORY_KEEP_ALIVE_MAX_VIEWS);
  });

  it("tightens on live heap pressure even on a roomy device", () => {
    setDeviceMemory(32);
    setHeap(950, 1000);
    expect(isUnderMemoryPressure()).toBe(true);
    expect(getRetainedModuleTtlMs()).toBe(LOW_MEMORY_RETAINED_MODULE_TTL_MS);
    expect(getKeepAliveTtlMs()).toBe(LOW_MEMORY_KEEP_ALIVE_TTL_MS);
  });

  it("keeps the larger caps when neither hint exists at all", () => {
    expect(isUnderMemoryPressure()).toBe(false);
    expect(getKeepAliveMaxViews()).toBe(DEFAULT_KEEP_ALIVE_MAX_VIEWS);
  });
});

describe("selectLruEvictions", () => {
  const times = (entries: Record<string, number>) =>
    new Map(Object.entries(entries));

  it("returns nothing when already within the cap", () => {
    expect(
      selectLruEvictions(["a", "b"], times({ a: 1, b: 2 }), 2, new Set()),
    ).toEqual([]);
  });

  it("evicts the oldest first", () => {
    expect(
      selectLruEvictions(
        ["a", "b", "c"],
        times({ a: 3, b: 1, c: 2 }),
        1,
        new Set(),
      ),
    ).toEqual(["b", "c"]);
  });

  it("never evicts an exempt id, and does not count it against the cap", () => {
    // The active and pinned views are always rendered, so `max` bounds only the
    // evictable set.
    const evicted = selectLruEvictions(
      ["active", "a", "b"],
      times({ active: 0, a: 1, b: 2 }),
      2,
      new Set(["active"]),
    );
    expect(evicted).toEqual([]);
  });

  it("breaks equal timestamps on id for determinism", () => {
    expect(
      selectLruEvictions(
        ["b", "a", "c"],
        times({ a: 5, b: 5, c: 5 }),
        1,
        new Set(),
      ),
    ).toEqual(["a", "b"]);
  });

  it("treats a missing or non-finite timestamp as oldest", () => {
    expect(
      selectLruEvictions(
        ["fresh", "missing", "bad"],
        times({ fresh: 100, bad: Number.NaN }),
        1,
        new Set(),
      ).sort(),
    ).toEqual(["bad", "missing"]);
  });

  it("does not mutate the input list", () => {
    const ids = ["b", "a"];
    selectLruEvictions(ids, times({ a: 1, b: 2 }), 0, new Set());
    expect(ids).toEqual(["b", "a"]);
  });
});

describe("planModuleCacheEvictions", () => {
  const entry = (
    refCount: number,
    lastUsedAt: number,
  ): ModuleCacheEntryLike => ({
    refCount,
    lastUsedAt,
  });

  it("never selects an entry that is still referenced", () => {
    // Evicting a live module would tear it out from under a mounted view.
    const active = entry(1, 0);
    const plan = planModuleCacheEvictions([active], {
      now: 1_000_000,
      ttlMs: 0,
      maxEntries: 0,
      force: true,
      totalSize: 1,
    });
    expect(plan).toEqual([]);
  });

  it("ttl-evicts idle entries past the window, oldest first", () => {
    const old = entry(0, 0);
    const recent = entry(0, 9_500);
    const plan = planModuleCacheEvictions([recent, old], {
      now: 10_000,
      ttlMs: 1_000,
      maxEntries: 10,
      force: false,
      totalSize: 2,
    });
    expect(plan).toEqual([{ entry: old, phase: "ttl" }]);
  });

  it("force-evicts every idle entry regardless of ttl", () => {
    const a = entry(0, 9_999);
    const b = entry(0, 10_000);
    const plan = planModuleCacheEvictions([a, b], {
      now: 10_000,
      ttlMs: 5_000_000,
      maxEntries: 10,
      force: true,
      totalSize: 2,
    });
    expect(plan.map((p) => p.phase)).toEqual(["ttl", "ttl"]);
  });

  it("lru-evicts the overflow left after the ttl sweep", () => {
    const a = entry(0, 100);
    const b = entry(0, 200);
    const c = entry(0, 300);
    const plan = planModuleCacheEvictions([a, b, c], {
      now: 400,
      ttlMs: 1_000_000,
      maxEntries: 1,
      force: false,
      totalSize: 3,
    });
    expect(plan).toEqual([
      { entry: a, phase: "lru" },
      { entry: b, phase: "lru" },
    ]);
  });

  it("counts ttl evictions against the cap before planning lru", () => {
    const stale = entry(0, 0);
    const fresh = entry(0, 1_000);
    const plan = planModuleCacheEvictions([stale, fresh], {
      now: 1_000,
      ttlMs: 500,
      maxEntries: 1,
      force: false,
      totalSize: 2,
    });
    // The TTL sweep already brought the cache within the cap.
    expect(plan).toEqual([{ entry: stale, phase: "ttl" }]);
  });

  it("never selects the same entry twice", () => {
    const a = entry(0, 0);
    const b = entry(0, 1);
    const plan = planModuleCacheEvictions([a, b], {
      now: 10_000,
      ttlMs: 0,
      maxEntries: 0,
      force: true,
      totalSize: 2,
    });
    expect(new Set(plan.map((p) => p.entry)).size).toBe(plan.length);
  });

  it("treats a non-finite lastUsedAt as oldest rather than skipping it", () => {
    const bad = entry(0, Number.NaN);
    const plan = planModuleCacheEvictions([bad], {
      now: 10_000,
      ttlMs: 1_000,
      maxEntries: 10,
      force: false,
      totalSize: 1,
    });
    expect(plan).toEqual([{ entry: bad, phase: "ttl" }]);
  });

  it("plans nothing for an empty cache", () => {
    expect(
      planModuleCacheEvictions([], {
        now: 0,
        ttlMs: 0,
        maxEntries: 0,
        force: true,
        totalSize: 0,
      }),
    ).toEqual([]);
  });
});
