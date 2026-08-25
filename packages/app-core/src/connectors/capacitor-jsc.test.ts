/**
 * Colocated coverage for the CapacitorJsc connector. Drives the real module:
 * plugin registration, the `jsc-ios` factory's three-part availability probe
 * (native platform, `ios`, plugin name), and the bridge adapter that forwards
 * evaluate / importModule / dispose to the native plugin and unwraps the
 * marshalled `{ value }` / `{ exports }` wire. The native plugin is a stand-in
 * because Node has no Swift JSContext; the connector itself is not mocked.
 */
import type { JsRuntimeFactory, JsValue } from "@elizaos/agent";
import { afterEach, describe, expect, it, vi } from "vitest";

type EvaluateOptions = {
  code: string;
  sourceUrl?: string;
  timeoutMs?: number;
};

type ImportOptions = {
  absolutePath: string;
  specifier?: string;
};

type CapacitorHost = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  isPluginAvailable?: (name: string) => boolean;
};

const harness = vi.hoisted(() => {
  const state = {
    factories: [] as JsRuntimeFactory[],
    evaluateCalls: [] as EvaluateOptions[],
    importCalls: [] as ImportOptions[],
    disposeCount: 0,
    pluginAvailableNames: [] as string[],
    evaluateHandler: async (
      options: EvaluateOptions,
    ): Promise<{ value: JsValue }> => ({
      value: { kind: "string", value: options.code },
    }),
    importHandler: async (
      options: ImportOptions,
    ): Promise<{ exports: JsValue }> => ({
      exports: { kind: "string", value: options.absolutePath },
    }),
    disposeHandler: async (): Promise<void> => {},
    plugin: {
      evaluate: async (options: EvaluateOptions) => {
        state.evaluateCalls.push(options);
        return state.evaluateHandler(options);
      },
      importModule: async (options: ImportOptions) => {
        state.importCalls.push(options);
        return state.importHandler(options);
      },
      dispose: async () => {
        state.disposeCount += 1;
        await state.disposeHandler();
      },
    },
  };
  return state;
});

vi.mock("@elizaos/agent", () => ({
  registerJsRuntimeFactory(factory: JsRuntimeFactory) {
    harness.factories.push(factory);
  },
}));

vi.mock("@capacitor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@capacitor/core")>();
  return {
    ...actual,
    registerPlugin: (name: string, implementations?: unknown) => {
      if (name === "CapacitorJsc") {
        return harness.plugin;
      }
      return actual.registerPlugin(
        name,
        implementations as Parameters<typeof actual.registerPlugin>[1],
      );
    },
  };
});

import { CapacitorJsc } from "./capacitor-jsc.ts";

const globalCap = globalThis as { Capacitor?: CapacitorHost };
const originalCapacitor = globalCap.Capacitor;

function jscFactory(): JsRuntimeFactory {
  const factory = harness.factories.find((entry) => entry.kind === "jsc-ios");
  if (!factory) {
    throw new Error("expected the connector to register a jsc-ios factory");
  }
  return factory;
}

function iosHost(overrides: Partial<CapacitorHost> = {}): CapacitorHost {
  return {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
    isPluginAvailable: (name) => {
      harness.pluginAvailableNames.push(name);
      return name === "CapacitorJsc";
    },
    ...overrides,
  };
}

function setHost(host: CapacitorHost | undefined): void {
  if (host === undefined) {
    delete globalCap.Capacitor;
    return;
  }
  globalCap.Capacitor = host;
}

afterEach(() => {
  harness.evaluateCalls.length = 0;
  harness.importCalls.length = 0;
  harness.disposeCount = 0;
  harness.pluginAvailableNames.length = 0;
  harness.evaluateHandler = async (options) => ({
    value: { kind: "string", value: options.code },
  });
  harness.importHandler = async (options) => ({
    exports: { kind: "string", value: options.absolutePath },
  });
  harness.disposeHandler = async () => {};
  if (originalCapacitor === undefined) {
    delete globalCap.Capacitor;
  } else {
    globalCap.Capacitor = originalCapacitor;
  }
});

describe("CapacitorJsc plugin registration", () => {
  it("exports the plugin object returned by registerPlugin('CapacitorJsc')", () => {
    expect(CapacitorJsc).toBe(harness.plugin);
  });

  it("registers exactly one jsc-ios factory at import time", () => {
    const kinds = harness.factories.map((factory) => factory.kind);
    expect(kinds).toEqual(["jsc-ios"]);
  });
});

describe("jsc-ios factory availability probe", () => {
  it("returns null when globalThis.Capacitor is unset (imported Capacitor is not native iOS)", async () => {
    setHost(undefined);
    expect(await jscFactory().create()).toBeNull();
  });

  it("returns null for an empty host that exposes no probe methods", async () => {
    setHost({});
    expect(await jscFactory().create()).toBeNull();
  });

  it("returns null when isNativePlatform is missing even if the rest matches", async () => {
    setHost(
      iosHost({
        isNativePlatform: undefined,
      }),
    );
    expect(await jscFactory().create()).toBeNull();
  });

  it("returns null when isNativePlatform is not strictly true", async () => {
    setHost(
      iosHost({
        isNativePlatform: () => false,
      }),
    );
    expect(await jscFactory().create()).toBeNull();
  });

  it("returns null when getPlatform is missing even on a native host", async () => {
    setHost(
      iosHost({
        getPlatform: undefined,
      }),
    );
    expect(await jscFactory().create()).toBeNull();
  });

  it("returns null on native Android even when the plugin is listed", async () => {
    setHost(
      iosHost({
        getPlatform: () => "android",
      }),
    );
    expect(await jscFactory().create()).toBeNull();
  });

  it("returns null on native web and on a case-mismatched iOS label", async () => {
    setHost(
      iosHost({
        getPlatform: () => "web",
      }),
    );
    expect(await jscFactory().create()).toBeNull();

    setHost(
      iosHost({
        getPlatform: () => "iOS",
      }),
    );
    expect(await jscFactory().create()).toBeNull();
  });

  it("returns null when the plugin is unavailable or the probe is missing", async () => {
    setHost(
      iosHost({
        isPluginAvailable: () => false,
      }),
    );
    expect(await jscFactory().create()).toBeNull();

    setHost(
      iosHost({
        isPluginAvailable: undefined,
      }),
    );
    expect(await jscFactory().create()).toBeNull();
  });

  it("returns null when a different plugin is available but CapacitorJsc is not", async () => {
    setHost(
      iosHost({
        isPluginAvailable: (name) => name === "CapacitorQuickJs",
      }),
    );
    expect(await jscFactory().create()).toBeNull();
  });

  it("creates a jsc-ios bridge only when native + ios + CapacitorJsc are all true", async () => {
    setHost(iosHost());
    const bridge = await jscFactory().create();
    expect(bridge).not.toBeNull();
    expect(bridge?.kind).toBe("jsc-ios");
    expect(harness.pluginAvailableNames).toEqual(["CapacitorJsc"]);
  });

  it("returns a new bridge instance on each successful create", async () => {
    setHost(iosHost());
    const first = await jscFactory().create();
    const second = await jscFactory().create();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second);
  });
});

describe("CapacitorJscBridge adapter", () => {
  async function createBridge() {
    setHost(iosHost());
    const bridge = await jscFactory().create();
    if (!bridge) {
      throw new Error("expected jsc-ios bridge when the plugin is available");
    }
    return bridge;
  }

  it("evaluate forwards code and optional fields, then returns the unwrapped value", async () => {
    const bridge = await createBridge();
    const value = await bridge.evaluate({
      code: "1 + 1",
      sourceUrl: "app://eval.js",
      timeoutMs: 250,
    });
    expect(harness.evaluateCalls).toEqual([
      { code: "1 + 1", sourceUrl: "app://eval.js", timeoutMs: 250 },
    ]);
    expect(value).toEqual({ kind: "string", value: "1 + 1" });
  });

  it("evaluate forwards a code-only payload, including the empty string", async () => {
    const bridge = await createBridge();
    const empty = await bridge.evaluate({ code: "" });
    expect(harness.evaluateCalls[0]).toEqual({ code: "" });
    expect(empty).toEqual({ kind: "string", value: "" });
  });

  it("evaluate returns every marshalled JsValue kind the plugin produces", async () => {
    const bridge = await createBridge();
    const kinds: JsValue[] = [
      { kind: "undefined" },
      { kind: "null" },
      { kind: "boolean", value: false },
      { kind: "number", value: 0 },
      { kind: "string", value: "" },
      { kind: "object", entries: [] },
      {
        kind: "object",
        entries: [["n", { kind: "number", value: 1 }]],
      },
      { kind: "array", items: [] },
      { kind: "array", items: [{ kind: "null" }] },
      { kind: "function", functionId: "fn:0" },
    ];
    for (const expected of kinds) {
      harness.evaluateHandler = async () => ({ value: expected });
      expect(await bridge.evaluate({ code: expected.kind })).toEqual(expected);
    }
  });

  it("evaluate rejects with the native timeout error rather than wrapping it", async () => {
    const bridge = await createBridge();
    harness.evaluateHandler = async () => {
      throw new Error("timeout");
    };
    await expect(
      bridge.evaluate({ code: "while(1){}", timeoutMs: 1 }),
    ).rejects.toThrow("timeout");
  });

  it("importModule forwards the absolute path and optional specifier, then returns exports", async () => {
    const bridge = await createBridge();
    const withSpecifier = await bridge.importModule({
      absolutePath: "/var/mobile/mod.js",
      specifier: "file:///var/mobile/mod.js",
    });
    expect(harness.importCalls[0]).toEqual({
      absolutePath: "/var/mobile/mod.js",
      specifier: "file:///var/mobile/mod.js",
    });
    expect(withSpecifier).toEqual({
      exports: { kind: "string", value: "/var/mobile/mod.js" },
    });

    const pathOnly = await bridge.importModule({
      absolutePath: "/var/mobile/other.js",
    });
    expect(harness.importCalls[1]).toEqual({
      absolutePath: "/var/mobile/other.js",
    });
    expect(pathOnly.exports).toEqual({
      kind: "string",
      value: "/var/mobile/other.js",
    });
  });

  it("importModule returns an empty exports object when the plugin yields one", async () => {
    const bridge = await createBridge();
    harness.importHandler = async () => ({
      exports: { kind: "object", entries: [] },
    });
    const result = await bridge.importModule({ absolutePath: "/empty.js" });
    expect(result).toEqual({ exports: { kind: "object", entries: [] } });
  });

  it("importModule rejects when the native plugin rejects", async () => {
    const bridge = await createBridge();
    harness.importHandler = async () => {
      throw new Error("module not found");
    };
    await expect(
      bridge.importModule({ absolutePath: "/missing.js" }),
    ).rejects.toThrow("module not found");
  });

  it("dispose forwards to the native plugin and awaits it", async () => {
    const bridge = await createBridge();
    let resolved = false;
    harness.disposeHandler = async () => {
      resolved = true;
    };
    await bridge.dispose();
    expect(harness.disposeCount).toBe(1);
    expect(resolved).toBe(true);
  });
});
