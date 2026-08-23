/**
 * Unit coverage for the mobile-boot side-effect barrel
 * `native-plugin-entrypoints`: the ordered Capacitor plugin import list, the
 * empty export surface, plugin registration on `@capacitor/core`, and the
 * import-time JS-runtime factories so `resolveJsRuntimeBridge()` can find
 * `jsc-ios` / `quickjs-*` on a Capacitor host. Drives the real module; no
 * mocks of the barrel.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Capacitor } from "@capacitor/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SOURCE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "native-plugin-entrypoints.ts",
);

const EXPECTED_IMPORTS = [
  "@elizaos/capacitor-camera",
  "@elizaos/capacitor-canvas",
  "@elizaos/capacitor-contacts",
  "@elizaos/capacitor-gateway",
  "@elizaos/capacitor-location",
  "@elizaos/capacitor-messages",
  "@elizaos/capacitor-mobile-agent-bridge",
  "@elizaos/capacitor-mobile-signals",
  "@elizaos/capacitor-appblocker",
  "@elizaos/capacitor-bun-runtime",
  "@elizaos/capacitor-phone",
  "@elizaos/capacitor-screencapture",
  "@elizaos/capacitor-swabble",
  "@elizaos/capacitor-system",
  "@elizaos/capacitor-talkmode",
  "@elizaos/capacitor-websiteblocker",
  "../connectors/capacitor-jsc.ts",
  "../connectors/capacitor-quickjs.ts",
] as const;

const WEB_PLUGIN_NAMES = [
  "ElizaCamera",
  "ElizaCanvas",
  "ElizaContacts",
  "Gateway",
  "ElizaLocation",
  "ElizaMessages",
  "MobileAgentBridge",
  "MobileSignals",
  "ElizaAppBlocker",
  "ElizaBunRuntime",
  "ElizaPhone",
  "ScreenCapture",
  "Swabble",
  "ElizaSystem",
  "TalkMode",
  "ElizaWebsiteBlocker",
] as const;

interface CapacitorHost {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  isPluginAvailable?: (name: string) => boolean;
}

function sourceImports(source: string): string[] {
  const matches = source.matchAll(/^import\s+"([^"]+)";$/gm);
  return [...matches].map((match) => match[1]);
}

function hideNodeVersion(): () => void {
  const original = process.versions.node;
  Object.defineProperty(process.versions, "node", {
    configurable: true,
    enumerable: true,
    value: undefined,
  });
  return () => {
    Object.defineProperty(process.versions, "node", {
      configurable: true,
      enumerable: true,
      value: original,
    });
  };
}

function installCapacitorHost(host: CapacitorHost): () => void {
  const globalCapacitor = globalThis as { Capacitor?: unknown };
  const previous = globalCapacitor.Capacitor;
  globalCapacitor.Capacitor = host;
  return () => {
    if (previous === undefined) {
      delete globalCapacitor.Capacitor;
    } else {
      globalCapacitor.Capacitor = previous;
    }
  };
}

describe("native-plugin-entrypoints source contract", () => {
  const source = readFileSync(SOURCE_PATH, "utf8");

  it("imports every native plugin and JS-runtime connector in boot order", () => {
    expect(sourceImports(source)).toEqual([...EXPECTED_IMPORTS]);
  });

  it("exports nothing — it is a side-effect barrel", () => {
    expect(source).not.toMatch(/^export\b/m);
  });
});

describe("native-plugin-entrypoints boot side effects", () => {
  it("evaluates to an empty module namespace", async () => {
    const loaded = await import("./native-plugin-entrypoints");
    expect(Object.keys(loaded)).toEqual([]);
  });

  it("returns the same module object on a second import", async () => {
    const first = await import("./native-plugin-entrypoints");
    const second = await import("./native-plugin-entrypoints");
    expect(second).toBe(first);
  });

  it("registers each Capacitor plugin that ships a web implementation", async () => {
    await import("./native-plugin-entrypoints");
    for (const name of WEB_PLUGIN_NAMES) {
      expect(Capacitor.isPluginAvailable(name), name).toBe(true);
    }
  });

  it("does not report a missing plugin as available", async () => {
    await import("./native-plugin-entrypoints");
    expect(Capacitor.isPluginAvailable("DefinitelyNotARegisteredPlugin")).toBe(
      false,
    );
  });

  it("leaves native-only JS-runtime plugins unavailable on the web platform", async () => {
    await import("./native-plugin-entrypoints");
    expect(Capacitor.getPlatform()).toBe("web");
    expect(Capacitor.isPluginAvailable("CapacitorJsc")).toBe(false);
    expect(Capacitor.isPluginAvailable("CapacitorQuickJs")).toBe(false);
  });

  it("still resolves the host-node bridge on Node after the barrel loads", async () => {
    await import("./native-plugin-entrypoints");
    const { resolveJsRuntimeBridge } = await import("@elizaos/agent");
    const bridge = await resolveJsRuntimeBridge();
    expect(bridge.kind).toBe("host-node");
    await bridge.dispose();
  });
});

describe("native-plugin-entrypoints JS-runtime factory registration", () => {
  const restorers: Array<() => void> = [];

  beforeEach(() => {
    vi.resetModules();
    const warn = console.warn.bind(console);
    vi.spyOn(console, "warn").mockImplementation((message, ...rest) => {
      if (
        typeof message === "string" &&
        message.includes("already registered. Cannot register plugins twice.")
      ) {
        return;
      }
      warn(message, ...rest);
    });
  });

  afterEach(() => {
    while (restorers.length > 0) {
      restorers.pop()?.();
    }
    vi.restoreAllMocks();
  });

  async function resolveOnCapacitorHost(host: CapacitorHost) {
    restorers.push(hideNodeVersion());
    restorers.push(installCapacitorHost(host));
    await import("./native-plugin-entrypoints");
    const { resolveJsRuntimeBridge } = await import("@elizaos/agent");
    return resolveJsRuntimeBridge();
  }

  it("selects jsc-ios on iOS when the JSC plugin is present", async () => {
    const bridge = await resolveOnCapacitorHost({
      isNativePlatform: () => true,
      getPlatform: () => "ios",
      isPluginAvailable: (name) => name === "CapacitorJsc",
    });
    expect(bridge.kind).toBe("jsc-ios");
  });

  it("prefers jsc-ios over the QuickJS fallback when both iOS plugins exist", async () => {
    const bridge = await resolveOnCapacitorHost({
      isNativePlatform: () => true,
      getPlatform: () => "ios",
      isPluginAvailable: (name) =>
        name === "CapacitorJsc" || name === "CapacitorQuickJs",
    });
    expect(bridge.kind).toBe("jsc-ios");
  });

  it("falls back to quickjs-ios-fallback when JSC is missing on iOS", async () => {
    const bridge = await resolveOnCapacitorHost({
      isNativePlatform: () => true,
      getPlatform: () => "ios",
      isPluginAvailable: (name) => name === "CapacitorQuickJs",
    });
    expect(bridge.kind).toBe("quickjs-ios-fallback");
  });

  it("selects quickjs-android on Android when the QuickJS plugin is present", async () => {
    const bridge = await resolveOnCapacitorHost({
      isNativePlatform: () => true,
      getPlatform: () => "android",
      isPluginAvailable: (name) => name === "CapacitorQuickJs",
    });
    expect(bridge.kind).toBe("quickjs-android");
  });

  it("does not select an iOS factory on Android even if JSC claims to be present", async () => {
    const bridge = await resolveOnCapacitorHost({
      isNativePlatform: () => true,
      getPlatform: () => "android",
      isPluginAvailable: (name) =>
        name === "CapacitorJsc" || name === "CapacitorQuickJs",
    });
    expect(bridge.kind).toBe("quickjs-android");
  });

  it("throws when no Capacitor JS-runtime plugin is available", async () => {
    await expect(
      resolveOnCapacitorHost({
        isNativePlatform: () => true,
        getPlatform: () => "ios",
        isPluginAvailable: () => false,
      }),
    ).rejects.toThrow(
      "[js-runtime-bridge] no JS runtime available (platform=ios)",
    );
  });

  it("throws on an unknown platform when every factory returns null", async () => {
    await expect(
      resolveOnCapacitorHost({
        isNativePlatform: () => false,
        getPlatform: () => "web",
        isPluginAvailable: () => false,
      }),
    ).rejects.toThrow(
      "[js-runtime-bridge] no JS runtime available (platform=web)",
    );
  });
});
