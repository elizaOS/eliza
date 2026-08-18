/**
 * Tests for overlay app registry lifecycle, platform availability, and registry conversion.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OverlayApp } from "./overlay-app-api.ts";
import {
  clearOverlayAppRegistry,
  getAllOverlayApps,
  getAvailableOverlayApps,
  getOverlayApp,
  isAospAndroid,
  isOverlayApp,
  overlayAppToRegistryInfo,
  registerOverlayApp,
  unregisterOverlayApp,
} from "./overlay-app-registry.ts";

describe("overlay-app-registry lifecycle", () => {
  beforeEach(() => {
    clearOverlayAppRegistry();
  });

  afterEach(() => {
    clearOverlayAppRegistry();
  });

  const sampleApp: OverlayApp = {
    name: "test-overlay",
    displayName: "Test Overlay",
    description: "A test overlay app",
    category: "tools",
    icon: "settings",
  };

  it("registers, retrieves, checks existence, and unregisters an overlay app", () => {
    expect(isOverlayApp("test-overlay")).toBe(false);
    expect(getOverlayApp("test-overlay")).toBeUndefined();

    registerOverlayApp(sampleApp);
    expect(isOverlayApp("test-overlay")).toBe(true);
    expect(getOverlayApp("test-overlay")).toBe(sampleApp);
    expect(getAllOverlayApps()).toEqual([sampleApp]);

    expect(unregisterOverlayApp("test-overlay")).toBe(true);
    expect(isOverlayApp("test-overlay")).toBe(false);
    expect(getOverlayApp("test-overlay")).toBeUndefined();
  });

  it("clears all registered apps via clearOverlayAppRegistry", () => {
    registerOverlayApp(sampleApp);
    registerOverlayApp({
      name: "another-app",
      displayName: "Another App",
      description: "Another description",
      category: "games",
      icon: "game",
    });

    expect(getAllOverlayApps().length).toBe(2);
    clearOverlayAppRegistry();
    expect(getAllOverlayApps().length).toBe(0);
  });

  it("guards against nullish and invalid registration inputs", () => {
    registerOverlayApp(null as unknown as OverlayApp);
    registerOverlayApp({} as unknown as OverlayApp);
    expect(getAllOverlayApps().length).toBe(0);

    expect(isOverlayApp(null as unknown as string)).toBe(false);
    expect(getOverlayApp(null as unknown as string)).toBeUndefined();
    expect(unregisterOverlayApp(null as unknown as string)).toBe(false);
  });
});

describe("getAvailableOverlayApps and isAospAndroid", () => {
  beforeEach(() => {
    clearOverlayAppRegistry();
  });

  afterEach(() => {
    clearOverlayAppRegistry();
  });

  const normalApp: OverlayApp = {
    name: "notes-app",
    displayName: "Notes",
    description: "Cross-platform notes",
    category: "tools",
    icon: "note",
  };

  const androidOnlyApp: OverlayApp = {
    name: "system-settings",
    displayName: "System Settings",
    description: "AOSP system settings",
    category: "tools",
    icon: "settings",
    androidOnly: true,
  };

  it("filters androidOnly apps on web and desktop platforms", () => {
    registerOverlayApp(normalApp);
    registerOverlayApp(androidOnlyApp);

    const webApps = getAvailableOverlayApps({
      platform: "web",
      aospAndroid: false,
    });
    expect(webApps).toEqual([normalApp]);

    const stockAndroidApps = getAvailableOverlayApps({
      platform: "android",
      aospAndroid: false,
    });
    expect(stockAndroidApps).toEqual([normalApp]);
  });

  it("includes androidOnly apps on AOSP Android builds", () => {
    registerOverlayApp(normalApp);
    registerOverlayApp(androidOnlyApp);

    const aospApps = getAvailableOverlayApps({
      platform: "android",
      aospAndroid: true,
    });
    expect(aospApps).toEqual([normalApp, androidOnlyApp]);
  });

  it("evaluates isAospAndroid accurately based on context and userAgent", () => {
    expect(isAospAndroid({ platform: "android", aospAndroid: true })).toBe(
      true,
    );
    expect(isAospAndroid({ platform: "android", aospAndroid: false })).toBe(
      false,
    );
    expect(isAospAndroid({ platform: "web" })).toBe(false);
    expect(
      isAospAndroid({
        platform: "android",
        userAgent:
          "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 ElizaOS/v2.0",
      }),
    ).toBe(true);
  });
});

describe("overlayAppToRegistryInfo", () => {
  it("converts an OverlayApp to a RegistryAppInfo object", () => {
    const app: OverlayApp = {
      name: "overlay-chat",
      displayName: "Overlay Chat",
      description: "Fast chat overlay",
      category: "chat",
      icon: "message",
      heroImage: "hero.png",
    };

    const info = overlayAppToRegistryInfo(app);
    expect(info.name).toBe("overlay-chat");
    expect(info.displayName).toBe("Overlay Chat");
    expect(info.launchType).toBe("overlay");
    expect(info.supports.v2).toBe(true);
    expect(info.heroImage).toBe("hero.png");
  });
});
