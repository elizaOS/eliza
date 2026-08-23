/**
 * Unit coverage for pluggable UI registry host store manager in registry-host.ts.
 *
 * Tests singleton store creation, memoization per key, custom registry host swapping,
 * and test cleanup reset.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getUiRegistryStore,
  provideUiRegistryHost,
  resetUiRegistryHostForTests,
  type UiRegistryHost,
} from "./registry-host.js";

describe("registry-host", () => {
  beforeEach(() => {
    resetUiRegistryHostForTests();
  });

  it("creates and memoizes stores per unique key", () => {
    const factory = vi.fn(() => ({ apps: [] as string[] }));

    const storeA1 = getUiRegistryStore("apps", factory);
    const storeA2 = getUiRegistryStore("apps", factory);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(storeA1).toBe(storeA2);
  });

  it("creates independent stores for distinct keys", () => {
    const storeApps = getUiRegistryStore("apps", () => ({ type: "apps" }));
    const storeSettings = getUiRegistryStore("settings", () => ({
      type: "settings",
    }));

    expect(storeApps).not.toBe(storeSettings);
    expect(storeApps.type).toBe("apps");
    expect(storeSettings.type).toBe("settings");
  });

  it("allows providing a custom UiRegistryHost implementation", () => {
    const customStore = { custom: true };
    const customHost: UiRegistryHost = {
      getStore: vi.fn(<T>(_key: string, _create: () => T) => customStore as T),
    };

    provideUiRegistryHost(customHost);

    const store = getUiRegistryStore("any-key", () => ({ default: true }));

    expect(customHost.getStore).toHaveBeenCalledTimes(1);
    expect(store).toBe(customStore);
  });

  it("resets stores and restores default host via resetUiRegistryHostForTests", () => {
    const factory = vi.fn(() => ({ count: 1 }));

    getUiRegistryStore("counter", factory);
    expect(factory).toHaveBeenCalledTimes(1);

    resetUiRegistryHostForTests();

    getUiRegistryStore("counter", factory);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
