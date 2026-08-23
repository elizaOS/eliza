/**
 * Unit tests for full-screen overlay app registry and platform availability filters.
 */

import { describe, expect, it } from "vitest";
import type { OverlayApp } from "./overlay-app-api.js";
import {
  getAllOverlayApps,
  getAvailableOverlayApps,
  getOverlayApp,
  isAospAndroid,
  isOverlayApp,
  overlayAppToRegistryInfo,
  registerOverlayApp,
} from "./overlay-app-registry.js";

function makeOverlayApp(overrides: Partial<OverlayApp> = {}): OverlayApp {
  return {
    name: "test-app",
    displayName: "Test App",
    description: "Overlay app for testing",
    category: "tools",
    icon: "tools-icon",
    component: (() => null) as unknown as OverlayApp["component"],
    ...overrides,
  };
}

describe("overlay app registry", () => {
  it("registers and retrieves overlay apps by name", () => {
    const app = makeOverlayApp({ name: "app-one", displayName: "App One" });
    registerOverlayApp(app);

    expect(isOverlayApp("app-one")).toBe(true);
    expect(isOverlayApp("nonexistent-app")).toBe(false);
    expect(getOverlayApp("app-one")).toBe(app);
    expect(getOverlayApp("nonexistent-app")).toBeUndefined();
    expect(getAllOverlayApps()).toContain(app);
  });

  it("filters out androidOnly apps on non-AOSP platforms", () => {
    const genericApp = makeOverlayApp({
      name: "generic-app",
      androidOnly: false,
    });
    const aospApp = makeOverlayApp({
      name: "aosp-privileged-app",
      androidOnly: true,
    });

    registerOverlayApp(genericApp);
    registerOverlayApp(aospApp);

    // Desktop/web platform
    const webAvailable = getAvailableOverlayApps({
      platform: "web",
      aospAndroid: false,
    });
    expect(webAvailable.some((a) => a.name === "generic-app")).toBe(true);
    expect(webAvailable.some((a) => a.name === "aosp-privileged-app")).toBe(
      false,
    );

    // Stock Android (non-AOSP Eliza fork)
    const stockAndroidAvailable = getAvailableOverlayApps({
      platform: "android",
      aospAndroid: false,
    });
    expect(stockAndroidAvailable.some((a) => a.name === "generic-app")).toBe(
      true,
    );
    expect(
      stockAndroidAvailable.some((a) => a.name === "aosp-privileged-app"),
    ).toBe(false);

    // AOSP ElizaOS Android build
    const aospAvailable = getAvailableOverlayApps({
      platform: "android",
      aospAndroid: true,
    });
    expect(aospAvailable.some((a) => a.name === "generic-app")).toBe(true);
    expect(aospAvailable.some((a) => a.name === "aosp-privileged-app")).toBe(
      true,
    );
  });

  it("evaluates isAospAndroid predicate with platform context", () => {
    expect(isAospAndroid({ platform: "android", aospAndroid: true })).toBe(
      true,
    );
    expect(isAospAndroid({ platform: "android", aospAndroid: false })).toBe(
      false,
    );
    expect(isAospAndroid({ platform: "ios", aospAndroid: true })).toBe(false);
  });

  it("converts OverlayApp to RegistryAppInfo format", () => {
    const app = makeOverlayApp({
      name: "converter-test-app",
      displayName: "Converter Test",
      description: "Test description",
      category: "utilities",
      icon: "util-icon",
      heroImage: "https://example.com/hero.png",
    });

    const registryInfo = overlayAppToRegistryInfo(app);

    expect(registryInfo).toEqual({
      name: "converter-test-app",
      displayName: "Converter Test",
      description: "Test description",
      category: "utilities",
      launchType: "overlay",
      launchUrl: null,
      icon: "util-icon",
      heroImage: "https://example.com/hero.png",
      capabilities: [],
      stars: 0,
      repository: "",
      latestVersion: null,
      supports: { v0: false, v1: false, v2: true },
      npm: {
        package: "converter-test-app",
        v0Version: null,
        v1Version: null,
        v2Version: null,
      },
    });
  });
});
