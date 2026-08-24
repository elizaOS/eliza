/**
 * Unit coverage for the GlassBridge native side of the glass tier — the TS
 * half of the Capacitor plugin contract in native-bridge.ts. Drives the REAL
 * module against a bridge-injected `globalThis.Capacitor`: platform gating,
 * lazy double memoization (plugin proxy + availability promise), the legacy
 * `Plugins` fallback, the J4 capability-probe error policy, and the explicit
 * `false`/no-op fallback signals callers rely on. Fakes exist only at the
 * `globalThis.Capacitor` seam the module itself defines; no vi.mock.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearNativeBackdrop,
  glassBridge,
  isNativeGlassAvailable,
  type NativeBackdropOptions,
  nativeGlassPlatform,
  resetGlassBridgeForTests,
  resetNativeGlassHost,
  setNativeBackdrop,
} from "./native-bridge";

type GlassBridgePlugin = NonNullable<ReturnType<typeof glassBridge>>;

const capacitorSlot = globalThis as { Capacitor?: unknown };

/** A complete plugin double; patch individual members per case. */
function pluginWith(
  patch: Partial<Record<keyof GlassBridgePlugin, unknown>> = {},
): GlassBridgePlugin {
  const base: GlassBridgePlugin = {
    attachGlass: () => Promise.resolve({ attached: true }),
    updateRect: () => Promise.resolve(),
    detachGlass: () => Promise.resolve(),
    setGrouping: () => Promise.resolve(),
    setBackdrop: () => Promise.resolve({ applied: true }),
    clearBackdrop: () => Promise.resolve(),
    reset: () => Promise.resolve(),
    isAvailable: () => Promise.resolve({ available: true }),
    getRegionState: () => Promise.resolve({ exists: false, regionCount: 0 }),
  };
  for (const [key, value] of Object.entries(patch)) {
    (base as unknown as Record<string, unknown>)[key] = value;
  }
  return base;
}

interface NativeCapacitor {
  isNativePlatform: () => boolean;
  getPlatform?: () => string;
  registerPlugin?: <T>(name: string) => T;
  Plugins?: Record<string, unknown>;
}

function installCapacitor(cap: NativeCapacitor): void {
  capacitorSlot.Capacitor = cap;
}

function nativeCap(overrides: Partial<NativeCapacitor> = {}): NativeCapacitor {
  return {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
    ...overrides,
  };
}

describe("glassBridge resolution", () => {
  let registerCalls: string[];

  beforeEach(() => {
    resetGlassBridgeForTests();
    delete capacitorSlot.Capacitor;
    registerCalls = [];
  });

  afterEach(() => {
    delete capacitorSlot.Capacitor;
    resetGlassBridgeForTests();
  });

  it("resolves null with no Capacitor global at all", () => {
    expect(glassBridge()).toBeNull();
  });

  it("caches the negative answer even once a Capacitor global appears later", () => {
    expect(glassBridge()).toBeNull();
    installCapacitor(nativeCap());
    expect(glassBridge()).toBeNull();
  });

  it("resolves null on a web (non-native) runtime even when the registry exists", () => {
    installCapacitor({
      isNativePlatform: () => false,
      getPlatform: () => "web",
      registerPlugin: <T>(name: string) => {
        registerCalls.push(name);
        return pluginWith() as T;
      },
    });
    expect(glassBridge()).toBeNull();
  });

  it("resolves null when native but the platform is neither ios nor android", () => {
    installCapacitor(nativeCap({ getPlatform: () => "electron" }));
    expect(glassBridge()).toBeNull();
  });

  it("resolves null when native and getPlatform is not implemented", () => {
    installCapacitor(nativeCap({ getPlatform: undefined }));
    expect(glassBridge()).toBeNull();
  });

  it("registers GlassBridge by name and memoizes the same proxy instance", () => {
    const plugin = pluginWith();
    installCapacitor(
      nativeCap({
        registerPlugin: <T>(name: string) => {
          registerCalls.push(name);
          return plugin as T;
        },
      }),
    );
    const first = glassBridge();
    const second = glassBridge();
    expect(registerCalls).toEqual(["GlassBridge"]);
    expect(first).toBe(plugin);
    expect(second).toBe(plugin);
  });

  it("falls back to the legacy Plugins map when registerPlugin is absent", () => {
    const plugin = pluginWith();
    installCapacitor(nativeCap({ Plugins: { GlassBridge: plugin } }));
    expect(glassBridge()).toBe(plugin);
  });

  it("resolves null when native with neither registerPlugin nor a Plugins entry", () => {
    installCapacitor(nativeCap({}));
    expect(glassBridge()).toBeNull();
  });

  it("resolves null when registration throws instead of crashing the caller", () => {
    installCapacitor(
      nativeCap({
        registerPlugin: <_T>() => {
          throw new Error("plugin not registered");
        },
      }),
    );
    expect(glassBridge()).toBeNull();
  });
});

describe("nativeGlassPlatform", () => {
  beforeEach(() => {
    resetGlassBridgeForTests();
    delete capacitorSlot.Capacitor;
  });

  afterEach(() => {
    delete capacitorSlot.Capacitor;
    resetGlassBridgeForTests();
  });

  it("reports null with no Capacitor global", () => {
    expect(nativeGlassPlatform()).toBeNull();
  });

  it("reports null on a web runtime", () => {
    installCapacitor({
      isNativePlatform: () => false,
      getPlatform: () => "web",
    });
    expect(nativeGlassPlatform()).toBeNull();
  });

  it("reports ios and android natively, independent of any plugin registration", () => {
    installCapacitor(nativeCap({ getPlatform: () => "ios" }));
    expect(nativeGlassPlatform()).toBe("ios");
    installCapacitor(nativeCap({ getPlatform: () => "android" }));
    expect(nativeGlassPlatform()).toBe("android");
  });

  it("reports null for an unrecognized native platform string", () => {
    installCapacitor(nativeCap({ getPlatform: () => "windows" }));
    expect(nativeGlassPlatform()).toBeNull();
  });

  it("re-reads the live global instead of caching a platform verdict", () => {
    installCapacitor(nativeCap({ getPlatform: () => "ios" }));
    expect(nativeGlassPlatform()).toBe("ios");
    installCapacitor(nativeCap({ getPlatform: () => "android" }));
    expect(nativeGlassPlatform()).toBe("android");
  });
});

describe("isNativeGlassAvailable", () => {
  beforeEach(() => {
    resetGlassBridgeForTests();
    delete capacitorSlot.Capacitor;
  });

  afterEach(() => {
    delete capacitorSlot.Capacitor;
    resetGlassBridgeForTests();
  });

  it("resolves false off-native and keeps the memoized verdict even once a capable shell appears", async () => {
    const first = isNativeGlassAvailable();
    const second = isNativeGlassAvailable();
    expect(second).toBe(first);
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    // The probe ran before any plugin existed; the memo must not re-probe.
    installCapacitor(nativeCap());
    await expect(isNativeGlassAvailable()).resolves.toBe(false);
  });

  it("resolves true on a registered plugin that reports itself available", async () => {
    installCapacitor(nativeCap({ registerPlugin: <T>() => pluginWith() as T }));
    await expect(isNativeGlassAvailable()).resolves.toBe(true);
  });

  it("resolves false when the bridge answers unavailable (pre-iOS 26 shell)", async () => {
    installCapacitor(
      nativeCap({
        registerPlugin: <T>() =>
          pluginWith({
            isAvailable: () => Promise.resolve({ available: false }),
          }) as T,
      }),
    );
    await expect(isNativeGlassAvailable()).resolves.toBe(false);
  });

  it("resolves false when the availability probe rejects", async () => {
    installCapacitor(
      nativeCap({
        registerPlugin: <T>() =>
          pluginWith({
            isAvailable: () => Promise.reject(new Error("old shell")),
          }) as T,
      }),
    );
    await expect(isNativeGlassAvailable()).resolves.toBe(false);
  });

  it("runs a fresh probe after resetGlassBridgeForTests clears the memo", async () => {
    installCapacitor(nativeCap({ registerPlugin: <T>() => pluginWith() as T }));
    const first = isNativeGlassAvailable();
    await first;
    resetGlassBridgeForTests();
    const second = isNativeGlassAvailable();
    expect(second).not.toBe(first);
    await expect(second).resolves.toBe(true);
  });
});

describe("setNativeBackdrop", () => {
  beforeEach(() => {
    resetGlassBridgeForTests();
    delete capacitorSlot.Capacitor;
  });

  afterEach(() => {
    delete capacitorSlot.Capacitor;
    resetGlassBridgeForTests();
  });

  it("answers false off-native without ever reaching the native side", async () => {
    let reachedNative = false;
    installCapacitor(
      nativeCap({
        registerPlugin: <T>() =>
          pluginWith({
            isAvailable: () => Promise.resolve({ available: false }),
            setBackdrop: () => {
              reachedNative = true;
              return Promise.resolve({ applied: true });
            },
          }) as T,
      }),
    );
    await expect(setNativeBackdrop({ color: "#000000" })).resolves.toBe(false);
    expect(reachedNative).toBe(false);
  });

  it("forwards the byte payload verbatim and returns the applied verdict", async () => {
    installCapacitor(nativeCap());
    const sent: NativeBackdropOptions[] = [];
    // Reach the resolved proxy and instrument setBackdrop through the same
    // plugin instance the module registered.
    const plugin = pluginWith({
      setBackdrop: (options: NativeBackdropOptions) => {
        sent.push(options);
        return Promise.resolve({ applied: true });
      },
    });
    installCapacitor(nativeCap({ registerPlugin: <T>() => plugin as T }));
    const payload: NativeBackdropOptions = {
      imageBase64: "aGVsbG8=",
      color: "#101010",
    };
    await expect(setNativeBackdrop(payload)).resolves.toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ imageBase64: "aGVsbG8=", color: "#101010" });
  });

  it("returns false as the explicit fallback signal when applied is false", async () => {
    installCapacitor(
      nativeCap({
        registerPlugin: <T>() =>
          pluginWith({
            setBackdrop: () => Promise.resolve({ applied: false }),
          }) as T,
      }),
    );
    await expect(setNativeBackdrop({ color: "#111111" })).resolves.toBe(false);
  });

  it("returns false when the native shell predates setBackdrop and throws", async () => {
    installCapacitor(
      nativeCap({
        registerPlugin: <T>() =>
          pluginWith({
            setBackdrop: () => Promise.reject(new Error("no setBackdrop")),
          }) as T,
      }),
    );
    await expect(setNativeBackdrop({ color: "#222222" })).resolves.toBe(false);
  });
});

describe("clearNativeBackdrop", () => {
  let clearCalls: number;

  beforeEach(() => {
    resetGlassBridgeForTests();
    delete capacitorSlot.Capacitor;
    clearCalls = 0;
  });

  afterEach(() => {
    delete capacitorSlot.Capacitor;
    resetGlassBridgeForTests();
  });

  it("resolves as a no-op when no bridge can be resolved", async () => {
    await expect(clearNativeBackdrop()).resolves.toBeUndefined();
  });

  it("clears through the bridge on a native runtime", async () => {
    installCapacitor(
      nativeCap({
        registerPlugin: <T>() =>
          pluginWith({
            clearBackdrop: () => {
              clearCalls += 1;
              return Promise.resolve();
            },
          }) as T,
      }),
    );
    await expect(clearNativeBackdrop()).resolves.toBeUndefined();
    expect(clearCalls).toBe(1);
  });

  it("still resolves when the old shell has no clearBackdrop and throws", async () => {
    installCapacitor(
      nativeCap({
        registerPlugin: <T>() =>
          pluginWith({
            clearBackdrop: () => Promise.reject(new Error("missing")),
          }) as T,
      }),
    );
    await expect(clearNativeBackdrop()).resolves.toBeUndefined();
  });
});

describe("resetNativeGlassHost", () => {
  let resetCalls: number;

  beforeEach(() => {
    resetGlassBridgeForTests();
    delete capacitorSlot.Capacitor;
    resetCalls = 0;
  });

  afterEach(() => {
    delete capacitorSlot.Capacitor;
    resetGlassBridgeForTests();
  });

  it("resolves as a no-op off-native", async () => {
    await expect(resetNativeGlassHost()).resolves.toBeUndefined();
    expect(resetCalls).toBe(0);
  });

  it("resets the native host so no previous document's regions survive", async () => {
    installCapacitor(
      nativeCap({
        registerPlugin: <T>() =>
          pluginWith({
            reset: () => {
              resetCalls += 1;
              return Promise.resolve();
            },
          }) as T,
      }),
    );
    await expect(resetNativeGlassHost()).resolves.toBeUndefined();
    expect(resetCalls).toBe(1);
  });

  it("still resolves when the shell predates reset() and throws", async () => {
    installCapacitor(
      nativeCap({
        registerPlugin: <T>() =>
          pluginWith({
            reset: () => Promise.reject(new Error("missing")),
          }) as T,
      }),
    );
    await expect(resetNativeGlassHost()).resolves.toBeUndefined();
  });
});
