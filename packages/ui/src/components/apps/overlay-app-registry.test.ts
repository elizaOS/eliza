import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OverlayApp } from "./overlay-app-api";
import {
  getAvailableOverlayApps,
  isAospAndroid,
  registerOverlayApp,
} from "./overlay-app-registry";

const OVERLAY_REGISTRY_KEY = "__elizaosOverlayAppRegistry__";

const ELIZAOS_AOSP_UA =
  "Mozilla/5.0 (Linux; Android 15; sdk_gphone64_x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.6367.243 Mobile Safari/537.36 ElizaOS/dev-2026-01";
const STOCK_ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.243 Mobile Safari/537.36";
const DESKTOP_LINUX_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.243 Safari/537.36";

function makeOverlayApp(name: string, androidOnly: boolean): OverlayApp {
  return {
    name,
    displayName: name,
    description: name,
    category: "system",
    icon: null,
    androidOnly: androidOnly || undefined,
    Component: () => null as never,
  };
}

describe("overlay-app-registry AOSP gating", () => {
  beforeEach(() => {
    // Wipe the cross-module registry so tests don't leak state into one another.
    (globalThis as { [OVERLAY_REGISTRY_KEY]?: Map<string, OverlayApp> })[
      OVERLAY_REGISTRY_KEY
    ] = new Map();
    registerOverlayApp(makeOverlayApp("@elizaos/app-phone", true));
    registerOverlayApp(makeOverlayApp("@elizaos/app-contacts", true));
    registerOverlayApp(makeOverlayApp("@elizaos/app-wifi", true));
    registerOverlayApp(makeOverlayApp("@elizaos/app-companion", false));
  });

  afterEach(() => {
    (globalThis as { [OVERLAY_REGISTRY_KEY]?: Map<string, OverlayApp> })[
      OVERLAY_REGISTRY_KEY
    ] = new Map();
  });

  it("hides androidOnly apps on stock Android (no AOSP marker)", () => {
    const apps = getAvailableOverlayApps({
      platform: "android",
      userAgent: STOCK_ANDROID_UA,
    });
    expect(apps.map((a) => a.name)).toEqual(["@elizaos/app-companion"]);
  });

  it("hides androidOnly apps on iOS even if a phantom AOSP marker leaks in", () => {
    const apps = getAvailableOverlayApps({
      platform: "ios",
      userAgent: ELIZAOS_AOSP_UA,
    });
    expect(apps.map((a) => a.name)).toEqual(["@elizaos/app-companion"]);
  });

  it("hides androidOnly apps on desktop Linux", () => {
    const apps = getAvailableOverlayApps({
      platform: "web",
      userAgent: DESKTOP_LINUX_UA,
    });
    expect(apps.map((a) => a.name)).toEqual(["@elizaos/app-companion"]);
  });

  it("shows androidOnly apps on AOSP elizaOS Android", () => {
    const apps = getAvailableOverlayApps({
      platform: "android",
      userAgent: ELIZAOS_AOSP_UA,
    });
    expect(apps.map((a) => a.name).sort()).toEqual([
      "@elizaos/app-companion",
      "@elizaos/app-contacts",
      "@elizaos/app-phone",
      "@elizaos/app-wifi",
    ]);
  });

  it("shows androidOnly apps on ElizaOS (carries both ElizaOS and ElizaOS markers)", () => {
    const apps = getAvailableOverlayApps({
      platform: "android",
      userAgent: ELIZAOS_AOSP_UA,
    });
    expect(apps.map((a) => a.name).sort()).toEqual([
      "@elizaos/app-companion",
      "@elizaos/app-contacts",
      "@elizaos/app-phone",
      "@elizaos/app-wifi",
    ]);
  });

  it("legacy string-context API hides androidOnly apps without explicit AOSP flag", () => {
    const apps = getAvailableOverlayApps("android");
    expect(apps.map((a) => a.name)).toEqual(["@elizaos/app-companion"]);
  });

  it("isAospAndroid agrees with the gate semantics", () => {
    expect(
      isAospAndroid({ platform: "android", userAgent: ELIZAOS_AOSP_UA }),
    ).toBe(true);
    expect(
      isAospAndroid({ platform: "android", userAgent: ELIZAOS_AOSP_UA }),
    ).toBe(true);
    expect(
      isAospAndroid({ platform: "android", userAgent: STOCK_ANDROID_UA }),
    ).toBe(false);
    expect(isAospAndroid({ platform: "ios", userAgent: ELIZAOS_AOSP_UA })).toBe(
      false,
    );
    expect(
      isAospAndroid({ platform: "web", userAgent: DESKTOP_LINUX_UA }),
    ).toBe(false);
  });
});
