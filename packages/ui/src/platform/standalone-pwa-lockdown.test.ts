// @vitest-environment jsdom

/**
 * Contract for the installed-PWA (iOS home-screen) touch-viewport lockdown.
 *
 * An installed iOS PWA runs on the `web` Capacitor platform (NOT the native
 * App Store build), so it never gets the `native`/`platform-ios` body class and
 * — before this fix — never got the mobile touch lockdown in styles/base.css.
 * Without the lockdown the body stays at the default `touch-action: auto` and
 * iOS WebKit eats the home-screen swipe-up (open chat) and horizontal rail flick
 * as its own page pan (pointercancel), so both gestures silently die though the
 * composer renders (issue: home-screen swipe gestures dead on iOS standalone PWA).
 *
 * These tests pin BOTH halves of the fix:
 *  1. platform/init.ts detects standalone display-mode and tags the body with
 *     `pwa-standalone` — but ONLY on the web platform (the native build already
 *     locks down; desktop must not).
 *  2. styles/base.css + styles.css apply the SAME lockdown to `body.pwa-standalone`
 *     as to `body.native` (touch-action claim, fixed body, no overscroll).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isStandalonePwa, setupPlatformStyles } from "./init";

/** Install a matchMedia stub that reports the given display-mode as active. */
function stubDisplayMode(mode: "standalone" | "fullscreen" | "browser"): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: query.includes(`display-mode: ${mode}`),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
}

afterEach(() => {
  document.body.className = "";
  // Drop any matchMedia / navigator.standalone stub so cases don't bleed.
  // biome-ignore lint/performance/noDelete: test teardown restoring host globals
  delete (window as { matchMedia?: unknown }).matchMedia;
  // biome-ignore lint/performance/noDelete: test teardown restoring host globals
  delete (navigator as { standalone?: unknown }).standalone;
});

describe("isStandalonePwa", () => {
  it("is true when the display-mode is standalone", () => {
    stubDisplayMode("standalone");
    expect(isStandalonePwa()).toBe(true);
  });

  it("is true when the display-mode is fullscreen (chrome-less PWA)", () => {
    stubDisplayMode("fullscreen");
    expect(isStandalonePwa()).toBe(true);
  });

  it("is FALSE in a normal browser tab (display-mode: browser)", () => {
    stubDisplayMode("browser");
    expect(isStandalonePwa()).toBe(false);
  });

  it("falls back to the legacy iOS navigator.standalone flag", () => {
    // Pre-display-mode iOS Safari only exposes navigator.standalone.
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: () =>
        ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList,
    });
    Object.defineProperty(navigator, "standalone", {
      configurable: true,
      value: true,
    });
    expect(isStandalonePwa()).toBe(true);
  });
});

describe("setupPlatformStyles — installed PWA lockdown", () => {
  it("adds the pwa-standalone body class when launched as an installed PWA on web", () => {
    // jsdom's Capacitor probe falls back to platform === "web" (the exact case
    // an installed iOS home-screen PWA reports).
    stubDisplayMode("standalone");
    setupPlatformStyles();
    expect(document.body.classList.contains("pwa-standalone")).toBe(true);
    // It must NOT masquerade as the native Capacitor build.
    expect(document.body.classList.contains("native")).toBe(false);
    expect(document.body.classList.contains("platform-web")).toBe(true);
  });

  it("does NOT add pwa-standalone in a normal browser tab", () => {
    stubDisplayMode("browser");
    setupPlatformStyles();
    expect(document.body.classList.contains("pwa-standalone")).toBe(false);
  });
});

describe("CSS lockdown contract — base.css / styles.css cover body.pwa-standalone", () => {
  // vitest runs with cwd = packages/ui, so resolve the CSS sources from there.
  const stylesDir = resolve(process.cwd(), "src/styles");
  const baseCss = readFileSync(resolve(stylesDir, "base.css"), "utf8");
  const stylesCss = readFileSync(resolve(stylesDir, "styles.css"), "utf8");

  it("gives body.pwa-standalone the same touch-viewport lockdown as body.native (base.css)", () => {
    // The lockdown group must claim touch-action / disable overscroll / lock the
    // body — otherwise the installed PWA keeps touch-action:auto and WebKit eats
    // the home swipes. Assert the selector list carries pwa-standalone alongside
    // native right before the `touch-action: pan-x pan-y` declaration.
    const lockdownBlock = baseCss.match(
      /body\.native,[\s\S]*?touch-action: pan-x pan-y;/,
    );
    expect(lockdownBlock).not.toBeNull();
    expect(lockdownBlock?.[0]).toContain("body.pwa-standalone");
  });

  it("hands horizontal drags to the app gestures for the installed PWA (styles.css touch-action: pan-y)", () => {
    // styles.css refines the body to `touch-action: pan-y` so only vertical pan
    // stays native and every horizontal drag reaches the rail/grabber. The
    // pwa-standalone selector must ride the same rule as body.native.
    const panYBlock = stylesCss.match(
      /body\.native,[\s\S]*?touch-action: pan-y;/,
    );
    expect(panYBlock).not.toBeNull();
    expect(panYBlock?.[0]).toContain("body.pwa-standalone");
  });

  it("locks #root to the viewport for the installed PWA too (styles.css)", () => {
    const rootBlock = stylesCss.match(
      /body\.native #root,[\s\S]*?max-height: 100dvh;/,
    );
    expect(rootBlock).not.toBeNull();
    expect(rootBlock?.[0]).toContain("body.pwa-standalone #root");
  });
});
