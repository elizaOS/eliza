// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MOBILE_RUNTIME_MODE_STORAGE_KEY,
  type MobileRuntimeMode,
  mobileRuntimeModeForServerTarget,
  normalizeMobileRuntimeMode,
  persistMobileRuntimeModeForServerTarget,
  readPersistedMobileRuntimeMode,
} from "../../src/onboarding/mobile-runtime-mode";

// Node 25 ships an experimental global `localStorage` that shadows the jsdom
// one with a stub missing all Storage methods. The persistence helpers under
// test read `window.localStorage`, so we install a minimal in-memory shim
// that satisfies the Storage interface and wins over both.
function installMemoryLocalStorage(): Storage {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) ?? null) : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
  return storage;
}

describe("MobileRuntimeMode", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = installMemoryLocalStorage();
    storage.clear();
  });

  afterEach(() => {
    storage.clear();
  });

  it("normalizeMobileRuntimeMode accepts the four canonical modes", () => {
    const cases: Array<MobileRuntimeMode> = [
      "remote-mac",
      "cloud",
      "cloud-hybrid",
      "local",
    ];
    for (const value of cases) {
      expect(normalizeMobileRuntimeMode(value)).toBe(value);
    }
  });

  it("normalizeMobileRuntimeMode rejects garbage", () => {
    expect(normalizeMobileRuntimeMode(undefined)).toBeNull();
    expect(normalizeMobileRuntimeMode(null)).toBeNull();
    expect(normalizeMobileRuntimeMode("")).toBeNull();
    expect(normalizeMobileRuntimeMode("desktop")).toBeNull();
    expect(normalizeMobileRuntimeMode("REMOTE-MAC")).toBeNull();
  });

  it("mobileRuntimeModeForServerTarget maps `local` server target to `local` mode", () => {
    expect(mobileRuntimeModeForServerTarget("local")).toBe("local");
    expect(mobileRuntimeModeForServerTarget("remote")).toBe("remote-mac");
    expect(mobileRuntimeModeForServerTarget("elizacloud")).toBe("cloud");
    expect(mobileRuntimeModeForServerTarget("elizacloud-hybrid")).toBe(
      "cloud-hybrid",
    );
    expect(mobileRuntimeModeForServerTarget("")).toBeNull();
  });

  it("persistMobileRuntimeModeForServerTarget('local') round-trips through localStorage", () => {
    persistMobileRuntimeModeForServerTarget("local");
    expect(storage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe("local");
    expect(readPersistedMobileRuntimeMode()).toBe("local");
  });

  it("clears the persisted mode when the server target is empty", () => {
    persistMobileRuntimeModeForServerTarget("local");
    expect(readPersistedMobileRuntimeMode()).toBe("local");
    persistMobileRuntimeModeForServerTarget("");
    expect(storage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe(null);
    expect(readPersistedMobileRuntimeMode()).toBe(null);
  });

  it("readPersistedMobileRuntimeMode survives a round-trip for every supported mode", () => {
    const matrix: Array<{
      target: "local" | "remote" | "elizacloud" | "elizacloud-hybrid";
      expected: MobileRuntimeMode;
    }> = [
      { target: "local", expected: "local" },
      { target: "remote", expected: "remote-mac" },
      { target: "elizacloud", expected: "cloud" },
      { target: "elizacloud-hybrid", expected: "cloud-hybrid" },
    ];
    for (const { target, expected } of matrix) {
      storage.clear();
      persistMobileRuntimeModeForServerTarget(target);
      expect(readPersistedMobileRuntimeMode()).toBe(expected);
    }
  });
});
