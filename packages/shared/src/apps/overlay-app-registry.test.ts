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
    Component: (() => null) as unknown as OverlayApp["Component"],
    ...overrides,
  };
}

describe("overlay-app registry", () => {
  it("registers and retrieves overlay apps by name", () => {
    const app = makeOverlayApp({ name: "app-one", displayName: "App One" });
    registerOverlayApp(app);

    expect(isOverlayApp("app-one")).toBe(true);
    expect(isOverlayApp("nonexistent-app")).toBe(false);
    expect(getOverlayApp("app-one")).toBe(app);
    expect(getOverlayApp("nonexistent-app")).toBeUndefined();
  });

  it("lists all registered apps", () => {
    registerOverlayApp(makeOverlayApp({ name: "app-a", displayName: "A" }));
    registerOverlayApp(makeOverlayApp({ name: "app-b", displayName: "B" }));
    const all = getAllOverlayApps();
    expect(all.some((a) => a.name === "app-a")).toBe(true);
    expect(all.some((a) => a.name === "app-b")).toBe(true);
  });

  it("overwrites on re-registration of the same name", () => {
    registerOverlayApp(
      makeOverlayApp({ name: "app-dup", displayName: "Original" }),
    );
    registerOverlayApp(
      makeOverlayApp({ name: "app-dup", displayName: "Updated" }),
    );
    expect(getOverlayApp("app-dup")?.displayName).toBe("Updated");
  });
});

describe("availability filtering", () => {
  it("hides androidOnly apps on non-AOSP platforms", () => {
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

    const webAvailable = getAvailableOverlayApps({
      platform: "web",
      aospAndroid: false,
    });
    expect(webAvailable.some((a) => a.name === "generic-app")).toBe(true);
    expect(webAvailable.some((a) => a.name === "aosp-privileged-app")).toBe(
      false,
    );

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
  });

  it("shows androidOnly apps on AOSP Android", () => {
    const aospApp = makeOverlayApp({
      name: "aosp-privileged-app-2",
      androidOnly: true,
    });
    registerOverlayApp(aospApp);

    const aospAvailable = getAvailableOverlayApps({
      platform: "android",
      aospAndroid: true,
    });
    expect(aospAvailable.some((a) => a.name === "aosp-privileged-app-2")).toBe(
      true,
    );
  });

  it("accepts a plain platform string", () => {
    const aospApp = makeOverlayApp({
      name: "aosp-plain-string-app",
      androidOnly: true,
    });
    registerOverlayApp(aospApp);
    const apps = getAvailableOverlayApps("android");
    expect(apps.some((a) => a.name === "aosp-plain-string-app")).toBe(false);
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

  it("detects AOSP from user agent", () => {
    expect(
      isAospAndroid({
        platform: "android",
        userAgent: "Mozilla ElizaOS/1.2.3",
      }),
    ).toBe(true);
    expect(
      isAospAndroid({ platform: "android", userAgent: "Mozilla plain" }),
    ).toBe(false);
    expect(isAospAndroid({ platform: "web" })).toBe(false);
  });
});

describe("registry info conversion", () => {
  it("maps overlay app fields into RegistryAppInfo", () => {
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

  it("defaults heroImage to null", () => {
    const info = overlayAppToRegistryInfo(
      makeOverlayApp({ name: "plain-app" }),
    );
    expect(info.heroImage).toBeNull();
  });
});
