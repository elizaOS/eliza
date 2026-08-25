/**
 * Colocated coverage for the CapacitorQuickJs connector. Drives the real
 * module: import-time factory registration, the native-platform / platform /
 * plugin-availability gate (including short-circuit and host-precedence
 * branches), and the bridge's evaluate / importModule / dispose forwarding.
 * The Kotlin/Swift plugin is not present in Node, so registerPlugin is
 * substituted with a recording double; assertions check unwrapping and
 * argument forwarding, not the double echoing its own return value.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JsValue } from "./capacitor-quickjs.ts";

type EvaluateOpts = {
  code: string;
  sourceUrl?: string;
  timeoutMs?: number;
};

type ImportOpts = {
  absolutePath: string;
  specifier?: string;
};

type CapturedBridge = {
  kind: string;
  evaluate: (opts: EvaluateOpts) => Promise<JsValue>;
  importModule: (opts: ImportOpts) => Promise<{ exports: JsValue }>;
  dispose: () => Promise<void>;
};

type CapturedFactory = {
  kind: string;
  create: () => Promise<CapturedBridge | null>;
};

type CapacitorHost = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  isPluginAvailable?: (name: string) => boolean;
};

const harness = vi.hoisted(() => {
  const factories: CapturedFactory[] = [];
  const plugin = {
    evaluate: vi.fn(),
    importModule: vi.fn(),
    dispose: vi.fn(),
  };
  const importedCapacitor: CapacitorHost = {
    isNativePlatform: () => false,
    getPlatform: () => "web",
    isPluginAvailable: () => false,
  };
  const registerPluginNames: string[] = [];
  return {
    factories,
    plugin,
    importedCapacitor,
    registerPluginNames,
  };
});

vi.mock("@elizaos/agent", () => ({
  registerJsRuntimeFactory: (factory: CapturedFactory) => {
    harness.factories.push(factory);
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: harness.importedCapacitor,
  registerPlugin: (name: string) => {
    harness.registerPluginNames.push(name);
    return harness.plugin;
  },
}));

const { CapacitorQuickJs } = await import("./capacitor-quickjs.ts");

function factory(kind: string): CapturedFactory {
  const found = harness.factories.find((entry) => entry.kind === kind);
  if (!found) {
    throw new Error(`expected factory ${kind} to be registered`);
  }
  return found;
}

function setImportedCapacitor(host: CapacitorHost): void {
  harness.importedCapacitor.isNativePlatform = host.isNativePlatform;
  harness.importedCapacitor.getPlatform = host.getPlatform;
  harness.importedCapacitor.isPluginAvailable = host.isPluginAvailable;
}

function setGlobalCapacitor(host: CapacitorHost | undefined): void {
  if (host === undefined) {
    Reflect.deleteProperty(globalThis, "Capacitor");
    return;
  }
  (globalThis as typeof globalThis & { Capacitor?: CapacitorHost }).Capacitor =
    host;
}

const nativeAndroid: CapacitorHost = {
  isNativePlatform: () => true,
  getPlatform: () => "android",
  isPluginAvailable: (name) => name === "CapacitorQuickJs",
};

const nativeIos: CapacitorHost = {
  isNativePlatform: () => true,
  getPlatform: () => "ios",
  isPluginAvailable: (name) => name === "CapacitorQuickJs",
};

afterEach(() => {
  setGlobalCapacitor(undefined);
  setImportedCapacitor({
    isNativePlatform: () => false,
    getPlatform: () => "web",
    isPluginAvailable: () => false,
  });
  harness.plugin.evaluate.mockReset();
  harness.plugin.importModule.mockReset();
  harness.plugin.dispose.mockReset();
});

describe("CapacitorQuickJs plugin registration", () => {
  it("registers the native plugin under the CapacitorQuickJs name and exports that handle", () => {
    expect(harness.registerPluginNames).toEqual(["CapacitorQuickJs"]);
    expect(CapacitorQuickJs).toBe(harness.plugin);
  });

  it("registers the android factory then the ios fallback, in that order", () => {
    expect(harness.factories.map((entry) => entry.kind)).toEqual([
      "quickjs-android",
      "quickjs-ios-fallback",
    ]);
  });
});

describe("quickjs-android factory create()", () => {
  it("returns null when the imported Capacitor host is not native", async () => {
    setGlobalCapacitor(undefined);
    expect(await factory("quickjs-android").create()).toBeNull();
  });

  it("returns null when isNativePlatform is missing", async () => {
    setGlobalCapacitor({
      getPlatform: () => "android",
      isPluginAvailable: () => true,
    });
    expect(await factory("quickjs-android").create()).toBeNull();
  });

  it("returns null when isNativePlatform is truthy but not strictly true", async () => {
    setGlobalCapacitor({
      isNativePlatform: () => "yes" as unknown as boolean,
      getPlatform: () => "android",
      isPluginAvailable: () => true,
    });
    expect(await factory("quickjs-android").create()).toBeNull();
  });

  it("does not probe the plugin when isNativePlatform is false", async () => {
    const isPluginAvailable = vi.fn(() => true);
    const getPlatform = vi.fn(() => "android");
    setGlobalCapacitor({
      isNativePlatform: () => false,
      getPlatform,
      isPluginAvailable,
    });
    expect(await factory("quickjs-android").create()).toBeNull();
    expect(getPlatform).not.toHaveBeenCalled();
    expect(isPluginAvailable).not.toHaveBeenCalled();
  });

  it("returns null on ios even when the plugin is available", async () => {
    setGlobalCapacitor(nativeIos);
    expect(await factory("quickjs-android").create()).toBeNull();
  });

  it("returns null on web", async () => {
    setGlobalCapacitor({
      isNativePlatform: () => true,
      getPlatform: () => "web",
      isPluginAvailable: () => true,
    });
    expect(await factory("quickjs-android").create()).toBeNull();
  });

  it("returns null when getPlatform is missing", async () => {
    setGlobalCapacitor({
      isNativePlatform: () => true,
      isPluginAvailable: () => true,
    });
    expect(await factory("quickjs-android").create()).toBeNull();
  });

  it("does not probe the plugin when the platform does not match", async () => {
    const isPluginAvailable = vi.fn(() => true);
    setGlobalCapacitor({
      isNativePlatform: () => true,
      getPlatform: () => "ios",
      isPluginAvailable,
    });
    expect(await factory("quickjs-android").create()).toBeNull();
    expect(isPluginAvailable).not.toHaveBeenCalled();
  });

  it("returns null when the plugin is unavailable", async () => {
    setGlobalCapacitor({
      isNativePlatform: () => true,
      getPlatform: () => "android",
      isPluginAvailable: () => false,
    });
    expect(await factory("quickjs-android").create()).toBeNull();
  });

  it("returns null when isPluginAvailable is missing", async () => {
    setGlobalCapacitor({
      isNativePlatform: () => true,
      getPlatform: () => "android",
    });
    expect(await factory("quickjs-android").create()).toBeNull();
  });

  it("returns null when isPluginAvailable is true only for a different plugin name", async () => {
    const names: string[] = [];
    setGlobalCapacitor({
      isNativePlatform: () => true,
      getPlatform: () => "android",
      isPluginAvailable: (name) => {
        names.push(name);
        return name === "CapacitorJsc";
      },
    });
    expect(await factory("quickjs-android").create()).toBeNull();
    expect(names).toEqual(["CapacitorQuickJs"]);
  });

  it("returns a quickjs-android bridge when native android has the plugin", async () => {
    setGlobalCapacitor(nativeAndroid);
    const bridge = await factory("quickjs-android").create();
    expect(bridge).not.toBeNull();
    expect(bridge?.kind).toBe("quickjs-android");
  });

  it("prefers globalThis.Capacitor over the imported Capacitor host", async () => {
    setImportedCapacitor(nativeAndroid);
    setGlobalCapacitor(nativeIos);
    expect(await factory("quickjs-android").create()).toBeNull();
  });

  it("falls back to the imported Capacitor host when globalThis.Capacitor is absent", async () => {
    setGlobalCapacitor(undefined);
    setImportedCapacitor(nativeAndroid);
    const bridge = await factory("quickjs-android").create();
    expect(bridge?.kind).toBe("quickjs-android");
  });
});

describe("quickjs-ios-fallback factory create()", () => {
  it("returns null on android even when the plugin is available", async () => {
    setGlobalCapacitor(nativeAndroid);
    expect(await factory("quickjs-ios-fallback").create()).toBeNull();
  });

  it("returns null when the platform string is the wrong case", async () => {
    setGlobalCapacitor({
      isNativePlatform: () => true,
      getPlatform: () => "iOS",
      isPluginAvailable: () => true,
    });
    expect(await factory("quickjs-ios-fallback").create()).toBeNull();
  });

  it("returns a quickjs-ios-fallback bridge when native ios has the plugin", async () => {
    setGlobalCapacitor(nativeIos);
    const bridge = await factory("quickjs-ios-fallback").create();
    expect(bridge).not.toBeNull();
    expect(bridge?.kind).toBe("quickjs-ios-fallback");
  });

  it("falls back to the imported Capacitor host for ios", async () => {
    setGlobalCapacitor(undefined);
    setImportedCapacitor(nativeIos);
    const bridge = await factory("quickjs-ios-fallback").create();
    expect(bridge?.kind).toBe("quickjs-ios-fallback");
  });
});

describe("CapacitorQuickJsBridge", () => {
  it("unwraps evaluate's { value } and forwards code, sourceUrl, and timeoutMs", async () => {
    setGlobalCapacitor(nativeAndroid);
    const returned: JsValue = { kind: "number", value: 7 };
    harness.plugin.evaluate.mockResolvedValue({ value: returned });
    const bridge = await factory("quickjs-android").create();
    if (!bridge) throw new Error("expected android bridge");

    const result = await bridge.evaluate({
      code: "1+6",
      sourceUrl: "eval.ts",
      timeoutMs: 250,
    });

    expect(harness.plugin.evaluate).toHaveBeenCalledOnce();
    expect(harness.plugin.evaluate).toHaveBeenCalledWith({
      code: "1+6",
      sourceUrl: "eval.ts",
      timeoutMs: 250,
    });
    expect(result).toBe(returned);
    expect(result).toEqual({ kind: "number", value: 7 });
  });

  it("forwards evaluate options that omit sourceUrl and timeoutMs", async () => {
    setGlobalCapacitor(nativeAndroid);
    harness.plugin.evaluate.mockResolvedValue({
      value: { kind: "undefined" },
    });
    const bridge = await factory("quickjs-android").create();
    if (!bridge) throw new Error("expected android bridge");

    await bridge.evaluate({ code: "void 0" });
    expect(harness.plugin.evaluate).toHaveBeenCalledWith({ code: "void 0" });
  });

  it("propagates evaluate rejection from the native plugin", async () => {
    setGlobalCapacitor(nativeAndroid);
    harness.plugin.evaluate.mockRejectedValue(new Error("timeout"));
    const bridge = await factory("quickjs-android").create();
    if (!bridge) throw new Error("expected android bridge");

    await expect(
      bridge.evaluate({ code: "while(true){}", timeoutMs: 1 }),
    ).rejects.toThrow("timeout");
  });

  it("unwraps importModule's { exports } and forwards absolutePath plus specifier", async () => {
    setGlobalCapacitor(nativeIos);
    const exports: JsValue = {
      kind: "object",
      entries: [["ok", { kind: "boolean", value: true }]],
    };
    harness.plugin.importModule.mockResolvedValue({ exports });
    const bridge = await factory("quickjs-ios-fallback").create();
    if (!bridge) throw new Error("expected ios bridge");

    const result = await bridge.importModule({
      absolutePath: "/data/mod.js",
      specifier: "file:///data/mod.js",
    });

    expect(harness.plugin.importModule).toHaveBeenCalledWith({
      absolutePath: "/data/mod.js",
      specifier: "file:///data/mod.js",
    });
    expect(result).toEqual({ exports });
    expect(result.exports).toBe(exports);
  });

  it("forwards importModule options that omit specifier", async () => {
    setGlobalCapacitor(nativeAndroid);
    harness.plugin.importModule.mockResolvedValue({
      exports: { kind: "null" },
    });
    const bridge = await factory("quickjs-android").create();
    if (!bridge) throw new Error("expected android bridge");

    const result = await bridge.importModule({
      absolutePath: "/data/only.js",
    });
    expect(harness.plugin.importModule).toHaveBeenCalledWith({
      absolutePath: "/data/only.js",
    });
    expect(result.exports).toEqual({ kind: "null" });
  });

  it("propagates importModule rejection from the native plugin", async () => {
    setGlobalCapacitor(nativeAndroid);
    harness.plugin.importModule.mockRejectedValue(
      new Error("module not found"),
    );
    const bridge = await factory("quickjs-android").create();
    if (!bridge) throw new Error("expected android bridge");

    await expect(
      bridge.importModule({ absolutePath: "/missing.js" }),
    ).rejects.toThrow("module not found");
  });

  it("forwards dispose to the native plugin", async () => {
    setGlobalCapacitor(nativeAndroid);
    harness.plugin.dispose.mockResolvedValue(undefined);
    const bridge = await factory("quickjs-android").create();
    if (!bridge) throw new Error("expected android bridge");

    await bridge.dispose();
    expect(harness.plugin.dispose).toHaveBeenCalledOnce();
  });

  it("propagates dispose rejection from the native plugin", async () => {
    setGlobalCapacitor(nativeAndroid);
    harness.plugin.dispose.mockRejectedValue(new Error("already disposed"));
    const bridge = await factory("quickjs-android").create();
    if (!bridge) throw new Error("expected android bridge");

    await expect(bridge.dispose()).rejects.toThrow("already disposed");
  });

  it("passes every JsValue kind through evaluate unchanged", async () => {
    setGlobalCapacitor(nativeAndroid);
    const bridge = await factory("quickjs-android").create();
    if (!bridge) throw new Error("expected android bridge");

    const values: JsValue[] = [
      { kind: "undefined" },
      { kind: "null" },
      { kind: "boolean", value: false },
      { kind: "number", value: 0 },
      { kind: "string", value: "" },
      { kind: "array", items: [] },
      {
        kind: "object",
        entries: [],
      },
      { kind: "function", functionId: "fn:0" },
    ];

    for (const value of values) {
      harness.plugin.evaluate.mockResolvedValueOnce({ value });
      const result = await bridge.evaluate({ code: "expr" });
      expect(result).toBe(value);
    }
  });
});
