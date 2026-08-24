/**
 * Tests the apps extension barrel (`src/apps/index.ts`) as the single public
 * entry point React and Node consumers import: overlay-app registration,
 * lookup and listing, AOSP platform-availability gating, detail-panel
 * extension wiring, and the catalog `RegistryAppInfo` mapping — all driven
 * through the barrel's re-exported bindings against the real globalThis-backed
 * registry host, reset around each case. Deterministic: no mocks, explicit
 * availability contexts everywhere.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RegistryAppInfo } from "../contracts/apps.js";
import { resetUiRegistryHostForTests } from "../registry-host.js";
import {
  getAppDetailExtension as directGetAppDetailExtension,
  registerDetailExtension as directRegisterDetailExtension,
} from "./detail-extension-registry.js";
import {
  getAllOverlayApps,
  getAppDetailExtension,
  getAvailableOverlayApps,
  getOverlayApp,
  isAospAndroid,
  isOverlayApp,
  overlayAppToRegistryInfo,
  registerDetailExtension,
  registerOverlayApp,
} from "./index";
import type { OverlayApp } from "./overlay-app-api.js";
import { registerOverlayApp as directRegisterOverlayApp } from "./overlay-app-registry.js";

const AOSP_ELIZAOS_UA =
  "Mozilla/5.0 (Linux; Android 15; sdk_gphone64_x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.243 Mobile Safari/537.36 ElizaOS/dev-2026-01";
const STOCK_ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.243 Mobile Safari/537.36";

function makeOverlayApp(name: string, androidOnly = false): OverlayApp {
  return {
    name,
    displayName: `${name} display`,
    description: `${name} description`,
    category: "system",
    icon: null,
    androidOnly: androidOnly || undefined,
    Component: () => null as never,
  };
}

function infoWithPanelId(detailPanelId: string | undefined): RegistryAppInfo {
  return {
    uiExtension: detailPanelId ? { detailPanelId } : undefined,
  } as RegistryAppInfo;
}

const noopComponent = () => null as never;

describe("apps entry-point barrel", () => {
  beforeEach(() => {
    resetUiRegistryHostForTests();
  });

  afterEach(() => {
    resetUiRegistryHostForTests();
  });

  it("re-exports the live registry implementations, not copies", () => {
    expect(registerOverlayApp).toBe(directRegisterOverlayApp);
    expect(registerDetailExtension).toBe(directRegisterDetailExtension);
    expect(getAppDetailExtension).toBe(directGetAppDetailExtension);
  });

  it("shares one process-global store between barrel and direct-module bindings", () => {
    const app = makeOverlayApp("@elizaos/plugin-feed");
    directRegisterOverlayApp(app);
    expect(getOverlayApp("@elizaos/plugin-feed")).toBe(app);
  });

  it("registers, looks up, lists and recognises overlay apps through one entry point", () => {
    const feed = makeOverlayApp("@elizaos/plugin-feed");
    const phone = makeOverlayApp("@elizaos/plugin-phone");
    registerOverlayApp(feed);
    registerOverlayApp(phone);

    expect(getOverlayApp("@elizaos/plugin-feed")).toBe(feed);
    expect(isOverlayApp("@elizaos/plugin-phone")).toBe(true);
    expect(isOverlayApp("@elizaos/plugin-missing")).toBe(false);

    const names = getAllOverlayApps().map((app) => app.name);
    expect(names).toEqual(["@elizaos/plugin-feed", "@elizaos/plugin-phone"]);
  });

  it("re-registering an existing name replaces the earlier definition", () => {
    const first = makeOverlayApp("@elizaos/plugin-feed");
    const second = { ...first, displayName: "Feed v2" };

    registerOverlayApp(first);
    registerOverlayApp(second);

    expect(getOverlayApp("@elizaos/plugin-feed")).toBe(second);
    expect(getAllOverlayApps()).toHaveLength(1);
  });

  it("gates androidOnly apps to AOSP Eliza-derived Android builds only", () => {
    registerOverlayApp(makeOverlayApp("@elizaos/plugin-phone", true));
    registerOverlayApp(makeOverlayApp("@elizaos/plugin-feed"));

    expect(
      getAvailableOverlayApps({
        platform: "android",
        userAgent: STOCK_ANDROID_UA,
      }).map((app) => app.name),
    ).toEqual(["@elizaos/plugin-feed"]);

    expect(
      getAvailableOverlayApps({
        platform: "web",
        userAgent: AOSP_ELIZAOS_UA,
      }).map((app) => app.name),
    ).toEqual(["@elizaos/plugin-feed"]);

    expect(
      getAvailableOverlayApps({
        platform: "android",
        userAgent: AOSP_ELIZAOS_UA,
      })
        .map((app) => app.name)
        .sort(),
    ).toEqual(["@elizaos/plugin-feed", "@elizaos/plugin-phone"]);
  });

  it("treats the legacy string context as a non-AOSP platform", () => {
    registerOverlayApp(makeOverlayApp("@elizaos/plugin-phone", true));
    registerOverlayApp(makeOverlayApp("@elizaos/plugin-feed"));

    expect(getAvailableOverlayApps("android").map((app) => app.name)).toEqual([
      "@elizaos/plugin-feed",
    ]);
    expect(getAvailableOverlayApps("web").map((app) => app.name)).toEqual([
      "@elizaos/plugin-feed",
    ]);
  });

  it("reports AOSP-Android only for the android platform carrying the framework marker", () => {
    expect(
      isAospAndroid({ platform: "android", userAgent: AOSP_ELIZAOS_UA }),
    ).toBe(true);
    expect(
      isAospAndroid({ platform: "android", userAgent: STOCK_ANDROID_UA }),
    ).toBe(false);
    expect(isAospAndroid({ platform: "web", userAgent: AOSP_ELIZAOS_UA })).toBe(
      false,
    );
  });

  it("derives availability from the ambient user agent when no context is passed", () => {
    registerOverlayApp(makeOverlayApp("@elizaos/plugin-phone", true));
    registerOverlayApp(makeOverlayApp("@elizaos/plugin-feed"));

    const names = getAvailableOverlayApps().map((app) => app.name);
    expect(names).toContain("@elizaos/plugin-feed");
    expect(names).not.toContain("@elizaos/plugin-phone");
  });

  it("returns null from the detail-panel lookup when the app declares no panel id", () => {
    expect(getAppDetailExtension(infoWithPanelId(undefined))).toBeNull();
  });

  it("returns null from the detail-panel lookup for an unregistered panel id", () => {
    expect(
      getAppDetailExtension(infoWithPanelId("never-registered")),
    ).toBeNull();
  });

  it("roundtrips a detail-panel registration to the exact component registered", () => {
    registerDetailExtension("example-detail-panel", noopComponent);

    expect(getAppDetailExtension(infoWithPanelId("example-detail-panel"))).toBe(
      noopComponent,
    );
  });

  it("serves the latest registration when a panel id is claimed twice", () => {
    const first = () => null as never;
    const second = () => null as never;

    registerDetailExtension("panel-2", first);
    registerDetailExtension("panel-2", second);

    expect(getAppDetailExtension(infoWithPanelId("panel-2"))).toBe(second);
  });

  it("maps an overlay app to catalog RegistryAppInfo through the barrel", () => {
    const app: OverlayApp = {
      ...makeOverlayApp("@elizaos/plugin-feed"),
      icon: "https://example.test/icon.png",
      heroImage: "https://example.test/hero.png",
    };

    expect(overlayAppToRegistryInfo(app)).toEqual({
      name: "@elizaos/plugin-feed",
      displayName: "@elizaos/plugin-feed display",
      description: "@elizaos/plugin-feed description",
      category: "system",
      launchType: "overlay",
      launchUrl: null,
      icon: "https://example.test/icon.png",
      heroImage: "https://example.test/hero.png",
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

  it("normalises a missing hero image to null in the catalog mapping", () => {
    const info = overlayAppToRegistryInfo(
      makeOverlayApp("@elizaos/plugin-wifi"),
    );

    expect(info.heroImage).toBeNull();
    expect(info.npm.package).toBe("@elizaos/plugin-wifi");
  });
});
