import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAllOverlayApps,
  getAppDetailExtension,
  getAvailableOverlayApps,
  getOverlayApp,
  isAospAndroid,
  isOverlayApp,
  type OverlayApp,
  overlayAppToRegistryInfo,
  registerDetailExtension,
  registerOverlayApp,
} from "./app-registries.js";
import type { RegistryAppInfo } from "./apps.js";

// The overlay registry is anchored on a single global slot so every module copy
// in a bundle converges on one store. This key MUST match verbatim — plugins
// register overlay apps against it and the shell reads them back through it.
const OVERLAY_REGISTRY_KEY = "__elizaosOverlayAppRegistry__";

const ELIZAOS_AOSP_UA =
  "Mozilla/5.0 (Linux; Android 15; sdk_gphone64_x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.6367.243 Mobile Safari/537.36 ElizaOS/dev-2026-01";
const WHITE_LABEL_AOSP_UA = `${ELIZAOS_AOSP_UA} AcmeOS/dev-2026-01`;
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

describe("overlay-app registry — global slot anchoring", () => {
  beforeEach(() => {
    (globalThis as { [OVERLAY_REGISTRY_KEY]?: Map<string, OverlayApp> })[
      OVERLAY_REGISTRY_KEY
    ] = new Map();
  });

  afterEach(() => {
    (globalThis as { [OVERLAY_REGISTRY_KEY]?: Map<string, OverlayApp> })[
      OVERLAY_REGISTRY_KEY
    ] = new Map();
  });

  it("anchors registrations on the shared globalThis slot (server-side, no window)", () => {
    // In the node test environment there is no `window`, so the registry must
    // fall back to `globalThis` — the exact convergence path the API process
    // uses. A registration made through the public function must be visible on
    // the raw global slot, proving the key is unchanged.
    const app = makeOverlayApp("@elizaos/plugin-feed", false);
    registerOverlayApp(app);
    const slot = (
      globalThis as { [OVERLAY_REGISTRY_KEY]?: Map<string, OverlayApp> }
    )[OVERLAY_REGISTRY_KEY];
    expect(slot).toBeInstanceOf(Map);
    expect(slot?.get("@elizaos/plugin-feed")).toBe(app);
    expect(getOverlayApp("@elizaos/plugin-feed")).toBe(app);
    expect(isOverlayApp("@elizaos/plugin-feed")).toBe(true);
    expect(isOverlayApp("@elizaos/plugin-absent")).toBe(false);
    expect(getAllOverlayApps().map((a) => a.name)).toEqual([
      "@elizaos/plugin-feed",
    ]);
  });

  it("reads back a registration seeded directly onto the global slot", () => {
    // The reverse of the above: a plugin chunk that registered against the raw
    // slot must be discoverable through the public read path.
    const seeded = makeOverlayApp("@elizaos/plugin-contacts", true);
    (globalThis as { [OVERLAY_REGISTRY_KEY]?: Map<string, OverlayApp> })[
      OVERLAY_REGISTRY_KEY
    ] = new Map([[seeded.name, seeded]]);
    expect(getOverlayApp("@elizaos/plugin-contacts")).toBe(seeded);
  });
});

describe("overlay-app registry — AOSP gating semantics", () => {
  beforeEach(() => {
    (globalThis as { [OVERLAY_REGISTRY_KEY]?: Map<string, OverlayApp> })[
      OVERLAY_REGISTRY_KEY
    ] = new Map();
    registerOverlayApp(makeOverlayApp("@elizaos/plugin-phone", true));
    registerOverlayApp(makeOverlayApp("@elizaos/plugin-contacts", true));
    registerOverlayApp(makeOverlayApp("@elizaos/plugin-wifi", true));
    registerOverlayApp(makeOverlayApp("@elizaos/plugin-feed", false));
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
    expect(apps.map((a) => a.name)).toEqual(["@elizaos/plugin-feed"]);
  });

  it("hides androidOnly apps on iOS even if a phantom AOSP marker leaks in", () => {
    const apps = getAvailableOverlayApps({
      platform: "ios",
      userAgent: ELIZAOS_AOSP_UA,
    });
    expect(apps.map((a) => a.name)).toEqual(["@elizaos/plugin-feed"]);
  });

  it("hides androidOnly apps on desktop Linux", () => {
    const apps = getAvailableOverlayApps({
      platform: "web",
      userAgent: DESKTOP_LINUX_UA,
    });
    expect(apps.map((a) => a.name)).toEqual(["@elizaos/plugin-feed"]);
  });

  it("shows androidOnly apps on AOSP elizaOS Android", () => {
    const apps = getAvailableOverlayApps({
      platform: "android",
      userAgent: ELIZAOS_AOSP_UA,
    });
    expect(apps.map((a) => a.name).sort()).toEqual([
      "@elizaos/plugin-contacts",
      "@elizaos/plugin-feed",
      "@elizaos/plugin-phone",
      "@elizaos/plugin-wifi",
    ]);
  });

  it("shows androidOnly apps on a white-label AOSP build carrying the base marker", () => {
    const apps = getAvailableOverlayApps({
      platform: "android",
      userAgent: WHITE_LABEL_AOSP_UA,
    });
    expect(apps.map((a) => a.name).sort()).toEqual([
      "@elizaos/plugin-contacts",
      "@elizaos/plugin-feed",
      "@elizaos/plugin-phone",
      "@elizaos/plugin-wifi",
    ]);
  });

  it("legacy string-context API hides androidOnly apps without explicit AOSP flag", () => {
    const apps = getAvailableOverlayApps("android");
    expect(apps.map((a) => a.name)).toEqual(["@elizaos/plugin-feed"]);
  });

  it("isAospAndroid agrees with the gate semantics", () => {
    expect(
      isAospAndroid({ platform: "android", userAgent: WHITE_LABEL_AOSP_UA }),
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

  it("rejects spoofed / malformed ElizaOS markers", () => {
    // `ElizaOS` alone (no `/tag`) must NOT count — the gate requires the
    // framework's `ElizaOS/<tag>` shape (a `\bElizaOS/\S` word-boundary match).
    expect(
      isAospAndroid({
        platform: "android",
        userAgent: "Mozilla/5.0 Android ElizaOS Mobile",
      }),
    ).toBe(false);
    // A trailing space after the slash (`ElizaOS/ `) has no tag char, so it
    // fails the `\S` requirement.
    expect(
      isAospAndroid({
        platform: "android",
        userAgent: "Mozilla/5.0 Android ElizaOS/ Mobile",
      }),
    ).toBe(false);
    // `NotElizaOS/2.4` has no word boundary before `ElizaOS`, so it is not the
    // framework marker.
    expect(
      isAospAndroid({
        platform: "android",
        userAgent: "Mozilla/5.0 Android NotElizaOS/2.4 Mobile",
      }),
    ).toBe(false);
  });
});

describe("overlayAppToRegistryInfo — catalog mapping", () => {
  it("maps an overlay app onto a v2-only RegistryAppInfo", () => {
    const app: OverlayApp = {
      name: "@elizaos/plugin-feed",
      displayName: "Feed",
      description: "Activity feed",
      category: "social",
      icon: "icon.png",
      heroImage: "hero.webp",
    };
    const info: RegistryAppInfo = overlayAppToRegistryInfo(app);
    expect(info).toEqual({
      name: "@elizaos/plugin-feed",
      displayName: "Feed",
      description: "Activity feed",
      category: "social",
      launchType: "overlay",
      launchUrl: null,
      icon: "icon.png",
      heroImage: "hero.webp",
      capabilities: [],
      stars: 0,
      repository: "",
      latestVersion: null,
      supports: { v0: false, v1: false, v2: true },
      npm: {
        package: "@elizaos/plugin-feed",
        v0Version: null,
        v1Version: null,
        v2Version: null,
      },
    });
  });

  it("defaults heroImage to null when the overlay app omits it", () => {
    const info = overlayAppToRegistryInfo({
      name: "@elizaos/plugin-x",
      displayName: "X",
      description: "x",
      category: "system",
      icon: null,
    });
    expect(info.heroImage).toBeNull();
  });
});

describe("detail-extension registry", () => {
  const detailPanelId = "example-detail-panel";
  const Component = () => null as never;

  it("round-trips a registered extension keyed by uiExtension.detailPanelId", () => {
    registerDetailExtension(detailPanelId, Component);
    const app = { uiExtension: { detailPanelId } } as RegistryAppInfo;
    expect(getAppDetailExtension(app)).toBe(Component);
  });

  it("returns null when the app declares no detailPanelId", () => {
    const app = {} as RegistryAppInfo;
    expect(getAppDetailExtension(app)).toBeNull();
  });

  it("returns null when no extension is registered for the panel id", () => {
    const app = {
      uiExtension: { detailPanelId: "unregistered-panel" },
    } as RegistryAppInfo;
    expect(getAppDetailExtension(app)).toBeNull();
  });
});
