// @vitest-environment jsdom
/**
 * Tests for plugin-bridge — capabilities detection and feature flags on web platform.
 */
import { describe, expect, it, vi } from "vitest";

import {
  getPluginCapabilities,
  isAndroid,
  isDesktop,
  isFeatureAvailable,
  isIOS,
  isMacOS,
  isNative,
  isWeb,
  platform,
} from "@elizaos/app-core/bridge";

describe("plugin-bridge", () => {
  // -- Platform --

  it("detects web platform in test env", () => {
    expect(platform).toBe("web");
    expect(isWeb()).toBe(true);
    expect(isNative).toBe(false);
    expect(isIOS).toBe(false);
    expect(isAndroid).toBe(false);
    expect(isDesktop()).toBe(false);
    expect(isMacOS()).toBe(isDesktop());
  });

  // -- Capabilities --

  describe("getPluginCapabilities", () => {
    const caps = getPluginCapabilities();

    it("gateway: available with websocket, no discovery", () => {
      expect(caps.gateway).toEqual(
        expect.objectContaining({
          available: true,
          websocket: true,
          discovery: false,
        }),
      );
    });

    it("canvas: always available", () => {
      expect(caps.canvas.available).toBe(true);
    });

    it("desktop: unavailable on web", () => {
      expect(caps.desktop).toEqual({
        available: false,
        tray: false,
        shortcuts: false,
        menu: false,
      });
    });

    it("location: no GPS or background on web", () => {
      expect(caps.location.gps).toBe(false);
      expect(caps.location.background).toBe(false);
    });

    it("has all expected capability groups", () => {
      for (const key of [
        "gateway",
        "voiceWake",
        "talkMode",
        "camera",
        "location",
        "screenCapture",
        "canvas",
        "desktop",
      ]) {
        expect(caps).toHaveProperty(key);
      }
    });
  });

  // -- Feature availability --

  describe("isFeatureAvailable", () => {
    it.each([
      ["gatewayDiscovery", false],
      ["desktopTray", false],
      ["elevenlabs", true],
      ["backgroundLocation", false],
    ] as const)("%s → %s on web", (feature, expected) => {
      expect(isFeatureAvailable(feature)).toBe(expected);
    });

    it("returns boolean for all known features", () => {
      const features = [
        "gatewayDiscovery",
        "voiceWake",
        "talkMode",
        "elevenlabs",
        "camera",
        "location",
        "backgroundLocation",
        "screenCapture",
        "desktopTray",
      ] as const;
      for (const f of features)
        expect(typeof isFeatureAvailable(f)).toBe("boolean");
    });
  });
});
