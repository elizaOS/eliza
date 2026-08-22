/** Exercises overlay app registration and platform availability with mocked host boundaries. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OverlayApp } from "../overlay-app-api.ts";
import {
  getAllOverlayApps,
  getAvailableOverlayApps,
  getOverlayApp,
  isAospAndroid,
  isOverlayApp,
  overlayAppToRegistryInfo,
  registerOverlayApp,
} from "../overlay-app-registry.ts";

// Fake registry store: a plain module-level map.
const store = new Map<string, unknown>();

vi.mock("../../registry-host.js", () => ({
  getUiRegistryStore: (_key: string, factory: () => unknown) => {
    if (!store.has(_key)) store.set(_key, factory());
    return store.get(_key);
  },
}));

vi.mock("../../platform/aosp-user-agent.js", () => ({
  userAgentHasElizaOSMarker: (ua: string) => ua.includes("ElizaOS/"),
}));

function fakeApp(
  name: string,
  overrides: Partial<OverlayApp> = {},
): OverlayApp {
  return {
    name,
    displayName: name,
    description: `desc ${name}`,
    category: "tools",
    launch: () => Promise.resolve(),
    icon: null,
    ...overrides,
  } as OverlayApp;
}

beforeEach(() => store.clear());
afterEach(() => store.clear());

describe("overlay-app registry", () => {
  it("registers and looks up apps", () => {
    registerOverlayApp(fakeApp("alpha"));
    expect(getOverlayApp("alpha")?.displayName).toBe("alpha");
    expect(isOverlayApp("alpha")).toBe(true);
    expect(isOverlayApp("missing")).toBe(false);
  });

  it("lists all registered apps", () => {
    registerOverlayApp(fakeApp("a"));
    registerOverlayApp(fakeApp("b"));
    expect(
      getAllOverlayApps()
        .map((a) => a.name)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("overwrites on re-registration of the same name", () => {
    registerOverlayApp(fakeApp("x", { displayName: "old" }));
    registerOverlayApp(fakeApp("x", { displayName: "new" }));
    expect(getAllOverlayApps()).toHaveLength(1);
    expect(getOverlayApp("x")?.displayName).toBe("new");
  });
});

describe("availability filtering", () => {
  it("hides androidOnly apps on non-AOSP platforms", () => {
    registerOverlayApp(fakeApp("normal"));
    registerOverlayApp(fakeApp("priv", { androidOnly: true }));
    const apps = getAvailableOverlayApps({
      platform: "android",
      aospAndroid: false,
    });
    expect(apps.map((a) => a.name)).toEqual(["normal"]);
  });

  it("shows androidOnly apps on AOSP Android", () => {
    registerOverlayApp(fakeApp("priv", { androidOnly: true }));
    const apps = getAvailableOverlayApps({
      platform: "android",
      aospAndroid: true,
    });
    expect(apps.map((a) => a.name)).toEqual(["priv"]);
  });

  it("accepts a plain platform string", () => {
    registerOverlayApp(fakeApp("priv", { androidOnly: true }));
    const apps = getAvailableOverlayApps("android");
    expect(apps).toHaveLength(0);
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
    const app = fakeApp("calc", {
      heroImage: "https://x/hero.png",
    });
    const info = overlayAppToRegistryInfo(app);
    expect(info.name).toBe("calc");
    expect(info.launchType).toBe("overlay");
    expect(info.heroImage).toBe("https://x/hero.png");
    expect(info.supports.v2).toBe(true);
    expect(info.npm.package).toBe("calc");
  });

  it("defaults heroImage to null", () => {
    const info = overlayAppToRegistryInfo(fakeApp("plain"));
    expect(info.heroImage).toBeNull();
  });
});
