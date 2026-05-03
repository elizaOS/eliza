import { afterEach, describe, expect, it } from "vitest";

import {
  __resetAnalysisModeFlagStoreForTests,
  getAnalysisModeFlagStore,
} from "./analysis-mode-flag-store.js";

describe("getAnalysisModeFlagStore", () => {
  afterEach(() => {
    __resetAnalysisModeFlagStoreForTests();
  });

  it("returns the same instance on repeated calls", () => {
    const a = getAnalysisModeFlagStore();
    const b = getAnalysisModeFlagStore();
    expect(a).toBe(b);
  });

  it("preserves per-room state across imports of the singleton", () => {
    const store = getAnalysisModeFlagStore();
    store.enable("room-singleton");
    expect(getAnalysisModeFlagStore().isEnabled("room-singleton")).toBe(true);

    getAnalysisModeFlagStore().disable("room-singleton");
    expect(store.isEnabled("room-singleton")).toBe(false);
  });

  it("test reset clears the singleton so a fresh instance is returned", () => {
    const first = getAnalysisModeFlagStore();
    first.enable("room-x");
    __resetAnalysisModeFlagStoreForTests();
    const second = getAnalysisModeFlagStore();
    expect(second).not.toBe(first);
    expect(second.isEnabled("room-x")).toBe(false);
  });
});
