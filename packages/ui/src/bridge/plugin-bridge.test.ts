/**
 * Verifies the plugin bridge: capability detection across the web baseline,
 * native mobile, and Electrobun desktop runtimes; the full isFeatureAvailable
 * switch; the desktop-aware singleton cache in getPlugins (stable identity
 * while the runtime marker holds, rebuild when it flips, snapshot semantics of
 * cached capabilities); and wrapPlugin's method-rebinding proxy. Deterministic
 * unit suite over a controlled @capacitor/core double plus real globalThis
 * window/navigator probes — no device and no Capacitor runtime.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Evaluates the bridge (and its mocked @capacitor/core dependency) once at
// collection time so the globalThis harness exists before any beforeEach.
import "./plugin-bridge";

interface CapacitorTestHarness {
  /** Value returned by `Capacitor.getPlatform()`. */
  platform: string;
  /** Value returned by `Capacitor.isNativePlatform()`. */
  native: boolean;
  /** Value exposed as `Capacitor.Plugins`; undefined models an absent registry. */
  corePlugins: Record<string, unknown> | undefined;
}

type HarnessGlobal = typeof globalThis & {
  __elizaPluginBridgeCapacitorHarness?: CapacitorTestHarness;
};

function harness(): CapacitorTestHarness {
  const state = (globalThis as HarnessGlobal)
    .__elizaPluginBridgeCapacitorHarness;
  if (!state) {
    throw new Error("capacitor core test harness was not installed");
  }
  return state;
}

vi.mock("@capacitor/core", () => {
  const state: CapacitorTestHarness = {
    platform: "web",
    native: false,
    corePlugins: undefined,
  };
  (globalThis as HarnessGlobal).__elizaPluginBridgeCapacitorHarness = state;
  return {
    Capacitor: {
      getPlatform: () => state.platform,
      isNativePlatform: () => state.native,
      get Plugins(): Record<string, unknown> | undefined {
        return state.corePlugins;
      },
    },
  };
});

const FEATURES = [
  "gatewayDiscovery",
  "voiceWake",
  "talkMode",
  "elevenlabs",
  "camera",
  "location",
  "backgroundLocation",
  "screenCapture",
  "phone",
  "contacts",
  "messages",
  "system",
  "desktopTray",
] as const;

function featureMatrix(mod: typeof import("./plugin-bridge")) {
  return Object.fromEntries(
    FEATURES.map((feature) => [feature, mod.isFeatureAvailable(feature)]),
  );
}

async function loadBridge(): Promise<typeof import("./plugin-bridge")> {
  vi.resetModules();
  return await import("./plugin-bridge");
}

beforeEach(() => {
  const state = harness();
  state.platform = "web";
  state.native = false;
  state.corePlugins = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getPluginCapabilities on the web baseline", () => {
  it("reports web fallback capabilities when no browser APIs are present", async () => {
    const mod = await loadBridge();

    expect(mod.getPluginCapabilities()).toEqual({
      gateway: { available: true, discovery: false, websocket: true },
      voiceWake: { available: false, continuous: false },
      talkMode: { available: false, elevenlabs: true, systemTts: false },
      camera: { available: false, photo: false, video: false },
      location: { available: false, gps: false, background: false },
      screenCapture: { available: false, screenshot: false, recording: false },
      canvas: { available: true },
      phone: { available: false },
      contacts: { available: false },
      messages: { available: false },
      system: { available: false },
      desktop: { available: false, tray: false, shortcuts: false, menu: false },
    });
  });

  it("gates voice wake and talk mode on real Web Speech presence", async () => {
    vi.stubGlobal("window", {});
    const withoutSpeech = await loadBridge();
    expect(withoutSpeech.getPluginCapabilities().voiceWake).toEqual({
      available: false,
      continuous: false,
    });

    vi.unstubAllGlobals();
    vi.stubGlobal("window", { SpeechRecognition: function SR() {} });
    const withSpeech = await loadBridge();

    // Continuous listening stays native-only even when Web Speech exists.
    expect(withSpeech.getPluginCapabilities().voiceWake).toEqual({
      available: true,
      continuous: false,
    });
    expect(withSpeech.isFeatureAvailable("voiceWake")).toBe(true);
    expect(withSpeech.getPluginCapabilities().talkMode.available).toBe(true);
  });

  it("derives system text-to-speech from window.speechSynthesis", async () => {
    vi.stubGlobal("window", {
      SpeechRecognition: function SR() {},
      speechSynthesis: {},
    });
    const mod = await loadBridge();

    expect(mod.getPluginCapabilities().talkMode).toEqual({
      available: true,
      elevenlabs: true,
      systemTts: true,
    });
  });

  it("derives camera capture from getUserMedia alone", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({}) },
    });
    const mod = await loadBridge();

    expect(mod.getPluginCapabilities().camera).toEqual({
      available: true,
      photo: true,
      video: true,
    });
    expect(mod.getPluginCapabilities().screenCapture).toEqual({
      available: false,
      screenshot: false,
      recording: false,
    });
    expect(mod.isFeatureAvailable("camera")).toBe(true);
  });

  it("adds screen recording only when getDisplayMedia is present", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: async () => ({}),
        getDisplayMedia: async () => ({}),
      },
    });
    const mod = await loadBridge();

    // Native screenshot support never comes from a web API.
    expect(mod.getPluginCapabilities().screenCapture).toEqual({
      available: true,
      screenshot: false,
      recording: true,
    });
    expect(mod.isFeatureAvailable("screenCapture")).toBe(true);
  });

  it("detects geolocation without granting native gps or background", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {
      geolocation: { getCurrentPosition() {} },
    });
    const mod = await loadBridge();

    expect(mod.getPluginCapabilities().location).toEqual({
      available: true,
      gps: false,
      background: false,
    });
    expect(mod.isFeatureAvailable("location")).toBe(true);
  });

  it("unlocks gateway discovery and the desktop quad under an Electrobun runtime", async () => {
    vi.stubGlobal("window", { __electrobunWindowId: 42 });
    const byWindowId = await loadBridge();

    expect(byWindowId.getPluginCapabilities().gateway.discovery).toBe(true);
    expect(byWindowId.getPluginCapabilities().desktop).toEqual({
      available: true,
      tray: true,
      shortcuts: true,
      menu: true,
    });
    expect(byWindowId.isFeatureAvailable("gatewayDiscovery")).toBe(true);
    expect(byWindowId.isFeatureAvailable("desktopTray")).toBe(true);

    vi.unstubAllGlobals();
    vi.stubGlobal("window", { __electrobunWebviewId: 7 });
    const byWebviewId = await loadBridge();

    expect(byWebviewId.getPluginCapabilities().desktop.tray).toBe(true);
  });
});

describe("getPluginCapabilities on native platforms", () => {
  it("opens the Android stack, gps, background location, and native media on Android", async () => {
    harness().platform = "android";
    harness().native = true;
    const mod = await loadBridge();

    // location.available still requires a geolocation provider, which this
    // bare probe environment lacks — while background flips on with nativeness.
    expect(mod.getPluginCapabilities()).toEqual({
      gateway: { available: true, discovery: true, websocket: true },
      voiceWake: { available: true, continuous: true },
      talkMode: { available: true, elevenlabs: true, systemTts: true },
      camera: { available: true, photo: true, video: true },
      location: { available: false, gps: true, background: true },
      screenCapture: { available: true, screenshot: true, recording: true },
      canvas: { available: true },
      phone: { available: true },
      contacts: { available: true },
      messages: { available: true },
      system: { available: true },
      desktop: { available: false, tray: false, shortcuts: false, menu: false },
    });
    expect(mod.isFeatureAvailable("backgroundLocation")).toBe(true);
    expect(mod.isFeatureAvailable("location")).toBe(false);
  });

  it("withholds the phone, contacts, messages, and system slots off Android", async () => {
    harness().platform = "ios";
    harness().native = true;
    const mod = await loadBridge();

    const caps = mod.getPluginCapabilities();
    expect(caps.phone).toEqual({ available: false });
    expect(caps.contacts).toEqual({ available: false });
    expect(caps.messages).toEqual({ available: false });
    expect(caps.system).toEqual({ available: false });

    // Nativeness itself still unlocks voice wake, gps, and background.
    expect(caps.voiceWake).toEqual({ available: true, continuous: true });
    expect(caps.location.gps).toBe(true);
    expect(caps.location.background).toBe(true);
  });
});

describe("isFeatureAvailable switch", () => {
  it("reports every feature unavailable on the bare web except ElevenLabs", async () => {
    const mod = await loadBridge();

    expect(featureMatrix(mod)).toEqual({
      gatewayDiscovery: false,
      voiceWake: false,
      talkMode: false,
      elevenlabs: true,
      camera: false,
      location: false,
      backgroundLocation: false,
      screenCapture: false,
      phone: false,
      contacts: false,
      messages: false,
      system: false,
      desktopTray: false,
    });
  });

  it("reports the full Android matrix with location gated behind geolocation", async () => {
    harness().platform = "android";
    harness().native = true;
    const mod = await loadBridge();

    expect(featureMatrix(mod)).toEqual({
      gatewayDiscovery: true,
      voiceWake: true,
      talkMode: true,
      elevenlabs: true,
      camera: true,
      location: false,
      backgroundLocation: true,
      screenCapture: true,
      phone: true,
      contacts: true,
      messages: true,
      system: true,
      desktopTray: false,
    });
  });

  it("keeps ElevenLabs available regardless of runtime", async () => {
    const web = await loadBridge();
    expect(web.isFeatureAvailable("elevenlabs")).toBe(true);

    harness().platform = "android";
    harness().native = true;
    const android = await loadBridge();
    expect(android.isFeatureAvailable("elevenlabs")).toBe(true);

    vi.unstubAllGlobals();
    vi.stubGlobal("window", { __electrobunWindowId: 1 });
    const desktop = await loadBridge();
    expect(desktop.isFeatureAvailable("elevenlabs")).toBe(true);
  });
});

describe("getPlugins singleton cache", () => {
  it("returns the same instance while the desktop state is stable", async () => {
    const mod = await loadBridge();
    const first = mod.getPlugins();
    const second = mod.getPlugins();

    expect(second).toBe(first);
    expect(Object.keys(first)).toEqual([
      "gateway",
      "swabble",
      "talkMode",
      "camera",
      "location",
      "screenCapture",
      "canvas",
      "phone",
      "contacts",
      "messages",
      "system",
      "desktop",
      "capabilities",
    ]);
  });

  it("rebuilds the instance when the Electrobun marker appears and disappears", async () => {
    const mod = await loadBridge();
    const webInstance = mod.getPlugins();
    expect(webInstance.desktop.isNative).toBe(false);

    vi.stubGlobal("window", { __electrobunWindowId: 1 });
    const desktopInstance = mod.getPlugins();

    expect(desktopInstance).not.toBe(webInstance);
    expect(desktopInstance.desktop.isNative).toBe(true);
    expect(desktopInstance.capabilities.gateway.discovery).toBe(true);

    vi.unstubAllGlobals();
    const rebuiltWebInstance = mod.getPlugins();

    expect(rebuiltWebInstance).not.toBe(desktopInstance);
    expect(rebuiltWebInstance).not.toBe(webInstance);
    expect(rebuiltWebInstance.desktop.isNative).toBe(false);
  });

  it("serves build-time capability snapshots until a rebuild is forced", async () => {
    const mod = await loadBridge();
    const cached = mod.getPlugins();
    expect(cached.capabilities.voiceWake.available).toBe(false);

    vi.stubGlobal("window", {
      SpeechRecognition: function SR() {},
      __electrobunWindowId: 1,
    });

    // Live detection sees Web Speech immediately; the cached instance does not.
    expect(mod.getPluginCapabilities().voiceWake.available).toBe(true);
    expect(cached.capabilities.voiceWake.available).toBe(false);

    const rebuilt = mod.getPlugins();
    expect(rebuilt).not.toBe(cached);
    expect(rebuilt.capabilities.voiceWake.available).toBe(true);
  });
});

describe("getPlugins plugin wiring", () => {
  it("wraps registry plugins with passthrough properties and rebound methods", async () => {
    const swabble = {
      cfg: { triggers: ["hey eliza"] },
      version: 7,
      async getConfig() {
        return { config: this.cfg };
      },
    };
    harness().corePlugins = { Swabble: swabble };
    const mod = await loadBridge();
    const plugins = mod.getPlugins();

    // Non-function values pass through untouched; functions keep their
    // receiver even when detached, so destructured calls stay on-target.
    expect(plugins.swabble.plugin.version).toBe(7);
    const detached = plugins.swabble.plugin.getConfig;
    await expect(detached()).resolves.toEqual({
      config: { triggers: ["hey eliza"] },
    });
  });

  it("stamps wrapper flags from the platform and capability snapshot", async () => {
    const mod = await loadBridge();
    const plugins = mod.getPlugins();

    expect(plugins.gateway).toMatchObject({
      isNative: false,
      hasFallback: true,
    });
    expect(plugins.canvas).toMatchObject({
      isNative: false,
      hasFallback: true,
    });
    expect(plugins.desktop).toMatchObject({
      isNative: false,
      hasFallback: false,
    });
    // Voice wake is unavailable on the bare web, so swabble has no fallback.
    expect(plugins.swabble).toMatchObject({
      isNative: false,
      hasFallback: false,
    });
    expect(plugins.phone).toMatchObject({
      isNative: false,
      hasFallback: false,
    });

    harness().native = true;
    harness().platform = "ios";
    const nativePlugins = await loadBridge().then((m) => m.getPlugins());
    expect(nativePlugins.swabble).toMatchObject({
      isNative: true,
      hasFallback: true,
    });
  });
});
