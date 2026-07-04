/**
 * Tests the shared overlay-app and detail-extension registries: the AOSP-gating
 * rules that decide which `androidOnly` overlay apps are visible per platform +
 * user-agent (real elizaOS AOSP, white-label AOSP, stock Android, iOS, desktop,
 * and the legacy string-context API) and the panel-id roundtrip for detail
 * extensions. Runs against the real registries with synthetic UA strings,
 * resetting the UI registry host around each case.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RegistryAppInfo } from "../contracts/apps.js";
import { resetUiRegistryHostForTests } from "../registry-host.js";
import {
  getAppDetailExtension,
  registerDetailExtension,
} from "./detail-extension-registry.js";
import type { AppDetailExtensionComponent } from "./detail-extension-types.js";
import type { OverlayApp } from "./overlay-app-api.js";
import {
  getAvailableOverlayApps,
  getOverlayApp,
  isAospAndroid,
  registerOverlayApp,
} from "./overlay-app-registry.js";

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

// The overlay-app + detail-extension registries were hand-copied between the
// React `@elizaos/ui` package and Node app-registration code (arch-audit
// #12093 item 6). They now live once here in `@elizaos/shared`; these tests own
// the canonical behavior, including the AOSP-gating edge cases the ui copy
// previously guarded.
describe("shared overlay-app-registry", () => {
  beforeEach(() => {
    resetUiRegistryHostForTests();
    registerOverlayApp(makeOverlayApp("@elizaos/plugin-phone", true));
    registerOverlayApp(makeOverlayApp("@elizaos/plugin-contacts", true));
    registerOverlayApp(makeOverlayApp("@elizaos/plugin-wifi", true));
    registerOverlayApp(makeOverlayApp("@elizaos/plugin-feed", false));
  });

  afterEach(() => {
    resetUiRegistryHostForTests();
  });

  it("registers and looks up an overlay app by name", () => {
    expect(getOverlayApp("@elizaos/plugin-feed")?.displayName).toBe(
      "@elizaos/plugin-feed",
    );
    expect(getOverlayApp("@elizaos/plugin-missing")).toBeUndefined();
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
});

describe("shared detail-extension registry", () => {
  const Extension: AppDetailExtensionComponent = () => null as never;

  it("roundtrips a registered detail extension by panel id", () => {
    registerDetailExtension("example-detail-panel", Extension);
    const app = {
      uiExtension: { detailPanelId: "example-detail-panel" },
    } as RegistryAppInfo;
    expect(getAppDetailExtension(app)).toBe(Extension);
  });

  it("returns null when the app declares no detail panel", () => {
    expect(getAppDetailExtension({} as RegistryAppInfo)).toBeNull();
  });
});
