/**
 * App inference cache state contract.
 *
 * Owns process-local inference app cache shared by repository mutations and
 * service reads. Hydration generations prevent an in-flight database read from
 * restoring an invalidated entry: invalidation must evict the entry AND bump
 * the generation so a concurrent hydration observed before the bump cannot
 * repopulate the cache with stale data.
 */

import { describe, expect, test } from "bun:test";

import {
  getAppHydrationGeneration,
  getInferenceApp,
  invalidateInferenceApp,
  setInferenceApp,
} from "./app-inference-cache-state";

describe("app inference cache state", () => {
  test("get returns null for an unknown app id", () => {
    expect(getInferenceApp("no-such-app")).toBeNull();
  });

  test("set then get returns the stored app", () => {
    const app = { id: "app-1", name: "Inference App" } as never;
    setInferenceApp("app-1", app);
    expect(getInferenceApp("app-1")).toBe(app);
  });

  test("invalidate evicts the entry so get returns null", () => {
    setInferenceApp("app-2", { id: "app-2" } as never);
    invalidateInferenceApp("app-2");
    expect(getInferenceApp("app-2")).toBeNull();
  });

  test("hydration generation starts at zero for unknown apps", () => {
    expect(getAppHydrationGeneration("app-3")).toBe(0);
  });

  test("invalidate bumps the hydration generation exactly once per call", () => {
    setInferenceApp("app-4", { id: "app-4" } as never);

    const before = getAppHydrationGeneration("app-4");
    invalidateInferenceApp("app-4");
    expect(getAppHydrationGeneration("app-4")).toBe(before + 1);

    invalidateInferenceApp("app-4");
    expect(getAppHydrationGeneration("app-4")).toBe(before + 2);
  });

  test("re-setting an entry after invalidation does not reset the generation", () => {
    setInferenceApp("app-5", { id: "app-5" } as never);
    invalidateInferenceApp("app-5");
    invalidateInferenceApp("app-5");

    setInferenceApp("app-5", { id: "app-5-refreshed" } as never);

    expect(getInferenceApp("app-5")).not.toBeNull();
    expect(getAppHydrationGeneration("app-5")).toBeGreaterThan(1);
  });
});
