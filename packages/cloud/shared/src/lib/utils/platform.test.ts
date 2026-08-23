/**
 * Covers platform detection and the safe-area inset reader.
 *
 * Every helper is expected to be safe on the server (no `window`), and the
 * inset reader is expected to return numbers callers can do layout math with.
 * `parseInt` returns NaN for a non-numeric custom property — and `--sat` is
 * conventionally declared as `env(safe-area-inset-top)`, which is exactly the
 * shape `parseInt` cannot read — so the reader is pinned to finite output.
 *
 * Browser cases install minimal globals and remove them afterwards.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  getPlatform,
  getPlatformConfig,
  getSafeAreaInsets,
  getUserAgentInfo,
  isAndroid,
  isBrowser,
  isIOS,
  isMobileApp,
  isTouchDevice,
  isWebView,
} from "./platform";

const g = globalThis as Record<string, unknown>;

function installBrowser(options: {
  userAgent?: string;
  vendor?: string;
  maxTouchPoints?: number;
  cssVars?: Record<string, string>;
  touchEvents?: boolean;
}): void {
  const vars = options.cssVars ?? {};
  g.window = {
    ...(options.touchEvents ? { ontouchstart: null } : {}),
    Notification: class {},
  };
  g.navigator = {
    userAgent: options.userAgent ?? "",
    vendor: options.vendor ?? "",
    platform: "test",
    language: "en-US",
    cookieEnabled: true,
    onLine: true,
    maxTouchPoints: options.maxTouchPoints ?? 0,
    vibrate: () => true,
  };
  g.document = { documentElement: {} };
  g.getComputedStyle = () => ({
    getPropertyValue: (name: string) => vars[name] ?? "",
  });
}

afterEach(() => {
  for (const key of ["window", "navigator", "document", "getComputedStyle"]) {
    delete g[key];
  }
});

describe("server environment", () => {
  test("reports no browser and an unknown platform", () => {
    expect(isBrowser()).toBe(false);
    expect(getPlatform()).toBe("unknown");
  });

  test("every capability probe answers false rather than throwing", () => {
    for (const probe of [isMobileApp, isIOS, isAndroid, isWebView, isTouchDevice]) {
      expect(probe()).toBe(false);
    }
  });

  test("returns zeroed insets and a server marker", () => {
    expect(getSafeAreaInsets()).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(getUserAgentInfo()).toEqual({ environment: "server" });
  });

  test("reports a non-mobile, non-touch config", () => {
    expect(getPlatformConfig()).toEqual({
      platform: "unknown",
      isMobile: false,
      isTouch: false,
      supportsNotifications: false,
      supportsHaptics: false,
    });
  });
});

describe("platform detection", () => {
  test("detects iOS from the user agent", () => {
    installBrowser({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari" });
    expect(isIOS()).toBe(true);
    expect(isAndroid()).toBe(false);
    expect(getPlatform()).toBe("ios");
  });

  test("detects Android from the user agent", () => {
    installBrowser({ userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome" });
    expect(isAndroid()).toBe(true);
    expect(getPlatform()).toBe("android");
  });

  test("falls back to web for a desktop user agent", () => {
    installBrowser({ userAgent: "Mozilla/5.0 (Macintosh) Safari" });
    expect(getPlatform()).toBe("web");
    expect(isMobileApp()).toBe(false);
  });

  test("falls back to navigator.vendor when userAgent is empty", () => {
    installBrowser({ userAgent: "", vendor: "iPad" });
    expect(isIOS()).toBe(true);
  });
});

describe("webview detection", () => {
  test("flags an Android WebView marker", () => {
    installBrowser({ userAgent: "Mozilla/5.0 (Linux; Android 14; wv) Chrome" });
    expect(isWebView()).toBe(true);
  });

  test("flags iOS without Safari, but not Safari itself", () => {
    installBrowser({ userAgent: "Mozilla/5.0 (iPhone) CriOS" });
    expect(isWebView()).toBe(true);
    installBrowser({ userAgent: "Mozilla/5.0 (iPhone) Safari" });
    expect(isWebView()).toBe(false);
  });
});

describe("touch and capability config", () => {
  test("detects touch from ontouchstart or maxTouchPoints", () => {
    installBrowser({ touchEvents: true });
    expect(isTouchDevice()).toBe(true);
    installBrowser({ maxTouchPoints: 5 });
    expect(isTouchDevice()).toBe(true);
    installBrowser({});
    expect(isTouchDevice()).toBe(false);
  });

  test("reports mobile only for ios/android", () => {
    installBrowser({ userAgent: "Mozilla/5.0 (iPhone) Safari" });
    expect(getPlatformConfig().isMobile).toBe(true);
    installBrowser({ userAgent: "Mozilla/5.0 (Macintosh) Safari" });
    expect(getPlatformConfig().isMobile).toBe(false);
  });
});

describe("getSafeAreaInsets", () => {
  test("reads pixel values from the custom properties", () => {
    installBrowser({
      cssVars: { "--sat": "44px", "--sar": "0px", "--sab": "34px", "--sal": "1px" },
    });
    expect(getSafeAreaInsets()).toEqual({ top: 44, right: 0, bottom: 34, left: 1 });
  });

  test("treats an unset custom property as zero", () => {
    installBrowser({ cssVars: {} });
    expect(getSafeAreaInsets()).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  test("returns finite numbers for an unresolved env() custom property", () => {
    // `--sat: env(safe-area-inset-top)` is the conventional declaration, and
    // parseInt cannot read it. Callers do layout arithmetic with these values,
    // so a NaN inset silently poisons every computed offset.
    installBrowser({
      cssVars: {
        "--sat": "env(safe-area-inset-top)",
        "--sar": "calc(1px + 2px)",
        "--sab": "auto",
        "--sal": "",
      },
    });
    const insets = getSafeAreaInsets();
    for (const [edge, value] of Object.entries(insets)) {
      expect(Number.isFinite(value), `${edge} must be finite`).toBe(true);
    }
    expect(insets).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  test("ignores a negative inset rather than shrinking the layout", () => {
    installBrowser({ cssVars: { "--sat": "-10px" } });
    expect(getSafeAreaInsets().top).toBeGreaterThanOrEqual(0);
  });
});
