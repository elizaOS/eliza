/**
 * Unit coverage for the retained-lazy loader's cache churn behavior and telemetry.
 * In-memory, no real modules.
 */
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleCacheTelemetryEvent } from "./cache-telemetry";
import {
  __resetRetainedLazyModulesForTests,
  acquireRetainedLazyModule,
  pruneRetainedLazyModules,
  type RetainedLazyLoader,
} from "./retained-lazy";
import { DEFAULT_RETAINED_MODULE_MAX_ENTRIES } from "./state/bounded-view-lru";

/**
 * End-to-end proof that the real route-chunk module cache (`retained-lazy.tsx`)
 * evicts under a multi-view walk (#10196). The issue names this exact gap:
 * "Module-cache eviction has unit coverage in isolation but no end-to-end proof
 * that real views evict, that `cleanup()` runs, and that retained-module count
 * stays bounded across many switches." Until now `retained-lazy` had no direct
 * test; this drives its real `acquire → load → release` lifecycle for N > cap
 * distinct "views" and asserts on the drained `module-cache-telemetry` ring.
 *
 * Runs in the default node env on purpose: with no `window`, the cache's
 * `scheduleIdleWork` prune runs synchronously on release (no fake timers), so
 * the LRU cap is enforced switch-by-switch exactly as it would be on an idle
 * frame in the browser — making the "bounded across switches" claim assertable.
 */

type Ring = ModuleCacheTelemetryEvent[];

const MAX = DEFAULT_RETAINED_MODULE_MAX_ENTRIES; // node env → roomy tier
const VIEW_COUNT = MAX + 6; // walk through more distinct views than the cap

interface TelemetryGlobal {
  __ELIZA_MODULE_CACHE_TELEMETRY__?: Ring;
}

function installRing(): Ring {
  const g = globalThis as typeof globalThis & TelemetryGlobal;
  g.__ELIZA_MODULE_CACHE_TELEMETRY__ = [];
  return g.__ELIZA_MODULE_CACHE_TELEMETRY__;
}

const flushMicrotasks = async () => {
  // cleanup() runs via `Promise.resolve().then(...)`; drain a few microtask turns.
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

/** A distinct "view" module: a trivial component plus a cleanup spy. */
function makeView(index: number) {
  const cleanup = vi.fn();
  const Component: ComponentType<Record<string, never>> = () => null;
  const loader: RetainedLazyLoader<Record<string, never>> = () =>
    Promise.resolve({ default: Component, cleanup });
  return { key: `test-view-${index}`, loader, cleanup };
}

describe("retained-lazy module cache — multi-view churn", () => {
  beforeEach(() => {
    __resetRetainedLazyModulesForTests();
    installRing();
  });

  afterEach(() => {
    __resetRetainedLazyModulesForTests();
    delete (globalThis as typeof globalThis & TelemetryGlobal)
      .__ELIZA_MODULE_CACHE_TELEMETRY__;
  });

  it("evicts + cleans up older views and stays bounded across many switches", async () => {
    const ring = installRing();
    const views = Array.from({ length: VIEW_COUNT }, (_, index) =>
      makeView(index),
    );

    // Walk every "view" once: open it (acquire + await load), then leave it
    // (release) — the same sequence a tab switch drives.
    for (const view of views) {
      const lease = acquireRetainedLazyModule(view.loader, {
        cacheKey: view.key,
      });
      await lease.promise;
      lease.release();
      await flushMicrotasks();
    }

    // During the walk (before any teardown), the LRU cap must have evicted the
    // overflow: exactly VIEW_COUNT - MAX of the oldest views.
    const evictedDuringWalk = ring.filter((e) => e.action === "evict").length;
    expect(evictedDuringWalk).toBe(VIEW_COUNT - MAX);
    expect(ring.filter((e) => e.action === "evict").map((e) => e.key)).toEqual(
      views.slice(0, VIEW_COUNT - MAX).map((view) => view.key),
    );

    // The oldest `VIEW_COUNT - MAX` views are evicted + cleaned up; the most
    // recent `MAX` are still retained (idle) so their cleanup has NOT run yet.
    const overflow = VIEW_COUNT - MAX;
    for (let i = 0; i < VIEW_COUNT; i += 1) {
      if (i < overflow) {
        expect(views[i].cleanup).toHaveBeenCalledTimes(1);
      } else {
        expect(views[i].cleanup).not.toHaveBeenCalled();
      }
    }

    // No telemetry event ever reported more retained entries than the cap once
    // the switch-time prune has run — i.e. an "evict" never leaves the cache
    // above MAX. (The transient pre-prune peak shows up on "load"/"release", so
    // assert the post-eviction invariant on the "evict" events.)
    for (const event of ring.filter((e) => e.action === "evict")) {
      expect(event.cacheSize).toBeLessThanOrEqual(MAX);
    }

    // Tearing the whole walk down (memory pressure / app pause) force-evicts the
    // retained tail: every view's module is dropped and cleaned up, nothing
    // leaks.
    pruneRetainedLazyModules({ force: true });
    await flushMicrotasks();
    for (const view of views) {
      expect(view.cleanup).toHaveBeenCalledTimes(1);
    }
    const finalEvent = ring.at(-1);
    expect(finalEvent?.cacheSize).toBe(0);
  });

  it("re-opening a retained view reuses the cached module (no second load)", async () => {
    const ring = installRing();
    const { loader } = makeView(0);

    const first = acquireRetainedLazyModule(loader);
    await first.promise;
    first.release();
    await flushMicrotasks();

    // Re-open immediately: still within the cap + TTL, so it is served from the
    // cache rather than loaded again.
    const second = acquireRetainedLazyModule(loader);
    await second.promise;
    second.release();
    await flushMicrotasks();

    expect(ring.filter((e) => e.action === "load")).toHaveLength(1);
  });
});
