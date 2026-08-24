/**
 * Unit coverage for the Capacitor bridge's web path — the one this jsdom
 * harness actually exercises (@capacitor/core reports platform "web",
 * isNativePlatform false, no Electrobun markers): capability flags, the
 * non-native haptics guard, plugin-registry Map semantics, window.Eliza
 * installation, and BRIDGE_READY_EVENT wiring. Real module, no mocks.
 */
// @vitest-environment jsdom

import { BRIDGE_READY_EVENT } from "@elizaos/shared/events";
import { describe, expect, it } from "vitest";
import {
  getCapabilities,
  getPlugin,
  haptics,
  hasPlugin,
  initializeCapacitorBridge,
  registerPlugin,
  waitForBridge,
} from "./capacitor-bridge";

describe("getCapabilities on a non-native web runtime", () => {
  it("reports the web platform with native-gated features off", () => {
    expect(getCapabilities()).toEqual({
      native: false,
      platform: "web",
      haptics: false,
      camera: false,
      microphone: false,
      screenCapture: false,
      fileSystem: false,
      notifications: false,
      geolocation: true,
      background: false,
      voiceWake: false,
    });
  });

  it("returns an equal snapshot on every call", () => {
    expect(getCapabilities()).toEqual(getCapabilities());
  });
});

describe("haptics guard on non-native platforms", () => {
  // The real module early-returns before touching @capacitor/haptics when
  // isNative is false; under jsdom that dynamic import would fail to resolve
  // a native implementation, so a resolved call proves the guard ran.
  it("resolves every haptic method as a no-op without loading the native plugin", async () => {
    await Promise.all([
      haptics.light(),
      haptics.medium(),
      haptics.heavy(),
      haptics.success(),
      haptics.warning(),
      haptics.error(),
      haptics.selectionStart(),
      haptics.selectionChanged(),
      haptics.selectionEnd(),
    ]);
  });
});

describe("plugin registry", () => {
  it("reports an unregistered name as absent", () => {
    expect(hasPlugin("bridge-test/never-registered")).toBe(false);
    expect(getPlugin("bridge-test/never-registered")).toBeUndefined();
  });

  it("returns the registered instance for its name", () => {
    const instance = { greet: () => "hello" };
    registerPlugin("bridge-test/greeter", instance);
    expect(hasPlugin("bridge-test/greeter")).toBe(true);
    expect(getPlugin("bridge-test/greeter")).toBe(instance);
  });

  it("keeps distinct names independent", () => {
    const first = { id: 1 };
    const second = { id: 2 };
    registerPlugin("bridge-test/two-a", first);
    registerPlugin("bridge-test/two-b", second);
    expect(getPlugin("bridge-test/two-a")).toBe(first);
    expect(getPlugin("bridge-test/two-b")).toBe(second);
  });

  it("replaces the instance when a name is registered twice", () => {
    const original = { version: 1 };
    const replacement = { version: 2 };
    registerPlugin("bridge-test/overwrite", original);
    registerPlugin("bridge-test/overwrite", replacement);
    expect(getPlugin("bridge-test/overwrite")).toBe(replacement);
    expect(getPlugin("bridge-test/overwrite")).not.toBe(original);
  });
});

describe("initializeCapacitorBridge", () => {
  it("installs window.Eliza with web platform info", () => {
    initializeCapacitorBridge();
    expect(window.Eliza.platform).toEqual({
      name: "web",
      isNative: false,
      isIOS: false,
      isAndroid: false,
      isDesktop: false,
      isWeb: true,
      isMacOS: false,
    });
  });

  it("exposes the same live capabilities object getCapabilities produces", () => {
    initializeCapacitorBridge();
    expect(window.Eliza.capabilities).toEqual(getCapabilities());
  });

  it("delegates plugin registry calls through the bridge to the module registry", () => {
    initializeCapacitorBridge();
    const instance = { ping: () => true };
    window.Eliza.registerPlugin("bridge-test/via-bridge", instance);
    expect(window.Eliza.hasPlugin("bridge-test/via-bridge")).toBe(true);
    expect(window.Eliza.getPlugin("bridge-test/via-bridge")).toBe(instance);
    expect(getPlugin("bridge-test/via-bridge")).toBe(instance);
  });

  it("exposes the plugin bridge with web fallback state", () => {
    initializeCapacitorBridge();
    expect(window.Eliza.plugins.desktop.isNative).toBe(false);
    expect(window.Eliza.pluginCapabilities.gateway.available).toBe(true);
    expect(window.Eliza.pluginCapabilities.gateway.websocket).toBe(true);
    expect(window.Eliza.pluginCapabilities.canvas.available).toBe(true);
    expect(typeof window.Eliza.isFeatureAvailable).toBe("function");
  });

  it("dispatches eliza:bridge-ready on document with the installed bridge as detail", () => {
    let readyDetail: unknown;
    const listener = (event: Event): void => {
      readyDetail = (event as CustomEvent<unknown>).detail;
    };
    document.addEventListener(BRIDGE_READY_EVENT, listener, { once: true });
    try {
      initializeCapacitorBridge();
      expect(readyDetail).toBe(window.Eliza);
    } finally {
      document.removeEventListener(BRIDGE_READY_EVENT, listener);
    }
  });
});

describe("waitForBridge", () => {
  it("resolves immediately when the bridge is already installed", async () => {
    initializeCapacitorBridge();
    await expect(waitForBridge()).resolves.toBe(window.Eliza);
  });

  it("stays pending until initialization installs the bridge", async () => {
    Reflect.deleteProperty(window, "Eliza");

    const pending = waitForBridge();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    initializeCapacitorBridge();
    await expect(pending).resolves.toBe(window.Eliza);
  });
});
