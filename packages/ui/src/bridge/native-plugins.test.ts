/**
 * Verifies the native-plugins bridge accessors: Capacitor registry resolution
 * order (core registry vs window-injected shell global), the wiring of every
 * named plugin key, the legacy-alias precedence chains, and getAgentPlugin's
 * registerPlugin fallback. Deterministic unit suite over a controlled
 * @capacitor/core double — no device and no Capacitor runtime.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs in the package-default node environment, where `window` exists only
// when a case stubs it — that lets the suite cover the no-window branch of
// the registry resolver that a jsdom environment could never reach.

interface CapacitorTestHarness {
  /** Value exposed as `Capacitor.Plugins`; undefined models an absent registry. */
  corePlugins: Record<string, unknown> | undefined;
  registered: Map<string, unknown>;
  registerPluginCalls: string[];
}

type HarnessGlobal = typeof globalThis & {
  __elizaNativePluginsCapacitorHarness?: CapacitorTestHarness;
};

function harness(): CapacitorTestHarness {
  const state = (globalThis as HarnessGlobal)
    .__elizaNativePluginsCapacitorHarness;
  if (!state) {
    throw new Error("capacitor core test harness was not installed");
  }
  return state;
}

vi.mock("@capacitor/core", () => {
  const state: CapacitorTestHarness = {
    corePlugins: undefined,
    registered: new Map(),
    registerPluginCalls: [],
  };
  (globalThis as HarnessGlobal).__elizaNativePluginsCapacitorHarness = state;
  return {
    Capacitor: {
      get Plugins(): Record<string, unknown> | undefined {
        return state.corePlugins;
      },
      registerPlugin(name: string): unknown {
        state.registerPluginCalls.push(name);
        return state.registered.get(name) ?? null;
      },
    },
  };
});

import {
  getAgentPlugin,
  getAppBlockerPlugin,
  getAppleCalendarPlugin,
  getCameraPlugin,
  getCanvasPlugin,
  getContactsPlugin,
  getDesktopPlugin,
  getElizaVoicePlugin,
  getGatewayPlugin,
  getLiveActivityPlugin,
  getLocationPlugin,
  getMessagesPlugin,
  getMobileSignalsPlugin,
  getNativePlugin,
  getPhonePlugin,
  getPushNotificationsPlugin,
  getScreenCapturePlugin,
  getSwabblePlugin,
  getSystemPlugin,
  getTalkModePlugin,
  getTesseractPlugin,
  getWebsiteBlockerPlugin,
} from "./native-plugins";

beforeEach(() => {
  const state = harness();
  state.corePlugins = undefined;
  state.registered.clear();
  state.registerPluginCalls.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getNativePlugin registry resolution", () => {
  it("returns the exact plugin registered under the Capacitor core registry", () => {
    const voice = { start: async () => ({ started: true }) };
    harness().corePlugins = { ElizaVoice: voice };

    expect(getNativePlugin("ElizaVoice")).toBe(voice);
  });

  it("prefers the Capacitor core registry over a window-injected registry", () => {
    const core = { id: "core" };
    const injected = { id: "injected" };
    harness().corePlugins = { Gateway: core };
    vi.stubGlobal("window", { Capacitor: { Plugins: { Gateway: injected } } });

    expect(getNativePlugin("Gateway")).toBe(core);
  });

  it("falls back to the window-injected Capacitor registry when the core exposes none", () => {
    const injected = { id: "injected" };
    harness().corePlugins = undefined;
    vi.stubGlobal("window", { Capacitor: { Plugins: { Canvas: injected } } });

    expect(getNativePlugin("Canvas")).toBe(injected);
  });

  it("satisfies lookups from an empty-but-present core registry without consulting the window fallback", () => {
    // An present-but-empty `Capacitor.Plugins` object is truthy, so the
    // resolver returns it directly instead of probing the shell global.
    const injected = { id: "injected" };
    harness().corePlugins = {};
    vi.stubGlobal("window", { Capacitor: { Plugins: { Canvas: injected } } });

    expect(getNativePlugin("Canvas")).toEqual({});
  });

  it("returns an empty plugin when window.Capacitor carries no Plugins registry", () => {
    vi.stubGlobal("window", { Capacitor: {} });

    expect(getNativePlugin("Desktop")).toEqual({});
  });

  it("returns an empty plugin when the window has no Capacitor global at all", () => {
    vi.stubGlobal("window", {});

    expect(getNativePlugin("Desktop")).toEqual({});
  });

  it("returns an empty plugin when no window exists at all", () => {
    expect(getNativePlugin("Desktop")).toEqual({});
  });

  it("reports absence as an empty plugin for unregistered names", () => {
    harness().corePlugins = { Gateway: { id: "gateway" } };

    expect(getNativePlugin("ElizaVoice")).toEqual({});
  });
});

describe("named accessors resolve their plugin key", () => {
  const namedAccessors: Array<[string, () => unknown]> = [
    ["ElizaVoice", getElizaVoicePlugin],
    ["Gateway", getGatewayPlugin],
    ["Swabble", getSwabblePlugin],
    ["TalkMode", getTalkModePlugin],
    ["ElizaLiveActivity", getLiveActivityPlugin],
    ["MobileSignals", getMobileSignalsPlugin],
    ["AppleCalendar", getAppleCalendarPlugin],
    ["PushNotifications", getPushNotificationsPlugin],
    ["Location", getLocationPlugin],
    ["ScreenCapture", getScreenCapturePlugin],
    ["Canvas", getCanvasPlugin],
    ["Desktop", getDesktopPlugin],
    ["ElizaPhone", getPhonePlugin],
    ["ElizaContacts", getContactsPlugin],
    ["ElizaMessages", getMessagesPlugin],
    ["ElizaSystem", getSystemPlugin],
  ];

  it.each(namedAccessors)(
    "resolves %s through its typed accessor",
    (pluginKey, accessor) => {
      const plugin = { marker: pluginKey };
      harness().corePlugins = { [pluginKey]: plugin };

      expect(accessor()).toBe(plugin);
    },
  );
});

describe("getAgentPlugin", () => {
  it("returns the registry Agent without consulting registerPlugin", () => {
    const agent = { request: async () => ({ status: 200 }) };
    const state = harness();
    state.corePlugins = { Agent: agent };
    state.registered.set("Agent", { id: "from-registerPlugin" });

    expect(getAgentPlugin()).toBe(agent);
    expect(state.registerPluginCalls).toEqual([]);
  });

  it("falls back to Capacitor.registerPlugin when the registry lacks Agent", () => {
    const registered = { start: async () => ({}) };
    const state = harness();
    state.corePlugins = { Gateway: { id: "gateway" } };
    state.registered.set("Agent", registered);

    expect(getAgentPlugin()).toBe(registered);
    expect(state.registerPluginCalls).toEqual(["Agent"]);
  });

  it("returns an empty plugin when neither the registry nor registerPlugin yields an Agent", () => {
    expect(getAgentPlugin()).toEqual({});
    expect(harness().registerPluginCalls).toEqual(["Agent"]);
  });
});

describe("legacy alias precedence chains", () => {
  const aliasChains: Array<[string, string, () => unknown]> = [
    ["ElizaAppBlocker", "AppBlocker", getAppBlockerPlugin],
    ["AppCamera", "Camera", getCameraPlugin],
    ["Tesseract", "ElizaTesseract", getTesseractPlugin],
    ["ElizaWebsiteBlocker", "WebsiteBlocker", getWebsiteBlockerPlugin],
  ];

  it.each(aliasChains)(
    "prefers %s over the legacy alias %s when both are registered",
    (primaryKey, legacyKey, accessor) => {
      const preferred = { v: primaryKey };
      const legacy = { v: legacyKey };
      harness().corePlugins = { [primaryKey]: preferred, [legacyKey]: legacy };

      expect(accessor()).toBe(preferred);
    },
  );

  it.each(aliasChains)(
    "resolves the legacy alias %s when %s is absent",
    (_primaryKey, legacyKey, accessor) => {
      const legacy = { v: legacyKey };
      harness().corePlugins = { [legacyKey]: legacy };

      expect(accessor()).toBe(legacy);
    },
  );

  it.each(aliasChains)(
    "returns an empty plugin when neither %s nor %s is registered",
    (_primaryKey, _legacyKey, accessor) => {
      harness().corePlugins = { Gateway: { id: "gateway" } };

      expect(accessor()).toEqual({});
    },
  );
});
