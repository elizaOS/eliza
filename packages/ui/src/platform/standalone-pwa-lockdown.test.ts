// @vitest-environment jsdom

/**
 * Contract for the installed-PWA (iOS home-screen) touch-viewport lockdown and
 * the full-bleed bottom geometry.
 *
 * An installed iOS PWA runs on the `web` Capacitor platform (NOT the native
 * App Store build), so it never gets the `native`/`platform-ios` body class and
 * — before the lockdown — kept the default `touch-action: auto`, so iOS WebKit
 * ate the home-screen swipe-up (open chat) and horizontal rail flick as its own
 * page pan (pointercancel) and both gestures silently died.
 *
 * The lockdown scroll-locks the body WITHOUT `position: fixed`. Pinning the body
 * `fixed` on the iOS Safari standalone PWA collapsed the initial containing
 * block for `position: fixed` DESCENDANTS (wallpaper, composer, safe-area floor)
 * to the small/layout viewport, so those layers stopped ~59px above the physical
 * bottom and `#root`'s near-black `--launch-bg` showed through as a home-indicator
 * "black band" — the bug an 8-deep pile of reclaim workarounds chased. An
 * exact-viewport-height, overflow-clipped body with `overscroll-behavior: none`
 * scroll-locks just as hard AND leaves the fixed-descendant ICB equal to the
 * true viewport, so the wallpaper reaches the real bottom with no reclaim math.
 *
 * These tests pin: (1) init.ts tags `pwa-standalone` only on web; (2) the CSS
 * lockdown is the NON-fixed lock for the PWA while the native build keeps
 * `position: fixed; inset: 0`; (3) the reclaim mechanism is GONE and no layer
 * references it.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isStandalonePwa, setupPlatformStyles } from "./init";

/** Strip `/* … *\/` comments so declaration-presence assertions don't trip on
 *  prose that merely NAMES a property (e.g. a comment explaining why the body is
 *  NOT `position: fixed`). */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

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
  delete (window as { matchMedia?: unknown }).matchMedia;
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
        ({
          matches: false,
          addEventListener() {},
          removeEventListener() {},
        }) as unknown as MediaQueryList,
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

  it("exposes only the top safe-area inset as the reserved margin (notch/camera)", () => {
    // The bottom margin is not reserved as app chrome; content/wallpaper bleeds
    // to the physical bottom. `--safe-area-top` is the notch/status-bar
    // clearance; `--safe-area-bottom` still exists as the value the composer
    // pads into for tappable home-indicator clearance, not a reserved black bar.
    stubDisplayMode("standalone");
    setupPlatformStyles();
    const top =
      document.documentElement.style.getPropertyValue("--safe-area-top");
    expect(top).toContain("env(safe-area-inset-top");
  });
});

describe("CSS lockdown contract — base.css / styles.css cover body.pwa-standalone", () => {
  // vitest runs with cwd = packages/ui, so resolve the CSS sources from there.
  const stylesDir = resolve(process.cwd(), "src/styles");
  const baseCss = readFileSync(resolve(stylesDir, "base.css"), "utf8");
  const stylesCss = readFileSync(resolve(stylesDir, "styles.css"), "utf8");

  it("gives body.pwa-standalone the same touch-viewport lockdown as body.native (base.css)", () => {
    // The lockdown group must claim touch-action / disable overscroll / clip the
    // body — otherwise the installed PWA keeps touch-action:auto and WebKit eats
    // the home swipes. Assert the selector list carries pwa-standalone alongside
    // native right before the `touch-action: pan-x pan-y` declaration.
    const lockdownBlock = baseCss.match(
      /body\.native,[\s\S]*?touch-action: pan-x pan-y;/,
    );
    expect(lockdownBlock).not.toBeNull();
    expect(lockdownBlock?.[0]).toContain("body.pwa-standalone");
  });

  it("scroll-locks the standalone PWA body WITHOUT position:fixed (base.css non-fixed lock)", () => {
    // The load-bearing invariant: the shared lockdown group (which includes
    // body.pwa-standalone) must lock scroll via clipped overflow + an exact
    // viewport height + `overscroll-behavior: none`, and must NOT pin the body
    // `position: fixed` — the fixed body is what collapsed the fixed-descendant
    // ICB and painted the home-indicator black band.
    const lockdownBlock = baseCss.match(
      /body\.native,\s*\n\s*body\.platform-ios,\s*\n\s*body\.platform-android,\s*\n\s*body\.pwa-standalone\s*\{([\s\S]*?)\}/,
    );
    expect(lockdownBlock).not.toBeNull();
    const body = lockdownBlock?.[1] ?? "";
    expect(body).toMatch(/overscroll-behavior:\s*none/);
    expect(body).toMatch(/overflow:\s*hidden/);
    expect(body).toMatch(/height:\s*100dvh/);
    // The group that includes pwa-standalone must NOT be position:fixed
    // (declarations only — ignore prose in comments that names the property).
    expect(stripCssComments(body)).not.toMatch(/position:\s*fixed/);
  });

  it("keeps the native (Capacitor) build on position:fixed + inset:0 (base.css)", () => {
    // The Safari-standalone ICB collapse does not apply to the native WKWebView
    // (its window IS the screen), so the native/platform-ios/platform-android
    // builds keep the fixed lockdown that fills the window.
    const nativeFixed = baseCss.match(
      /body\.native,\s*\n\s*body\.platform-ios,\s*\n\s*body\.platform-android\s*\{([\s\S]*?)\}/g,
    );
    expect(nativeFixed).not.toBeNull();
    // At least one such block pins position:fixed + inset:0 (and it must NOT
    // list pwa-standalone).
    const fixedBlock = (nativeFixed ?? []).find(
      (b) => /position:\s*fixed/.test(b) && /inset:\s*0/.test(b),
    );
    expect(fixedBlock).toBeTruthy();
    expect(fixedBlock ?? "").not.toContain("pwa-standalone");
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

  it("fills #root to the viewport (100dvh) for the installed PWA — full-bleed to the bottom", () => {
    // With the non-fixed body there is no ICB collapse, so `#root` simply fills
    // the viewport (`100dvh`, `100vh` fallback) and the app paints to the true
    // physical bottom. No `100lvh` reclaim gymnastics.
    const rootBlock = stylesCss.match(
      /body\.native #root,[\s\S]*?max-height: 100dvh;/,
    );
    expect(rootBlock).not.toBeNull();
    expect(rootBlock?.[0]).toContain("body.pwa-standalone #root");
    expect(rootBlock?.[0]).toContain("100dvh");
    expect(rootBlock?.[0]).toContain("100vh");
    // The obsolete large-viewport reclaim unit must be gone.
    expect(rootBlock?.[0]).not.toContain("100lvh");
  });

  it("fills the app shell column to the viewport (100dvh) for the installed PWA (styles.css)", () => {
    const columnBlock = stylesCss.match(
      /body\.native \[data-app-shell-root\],[\s\S]*?height: 100dvh;/,
    );
    expect(columnBlock).not.toBeNull();
    expect(columnBlock?.[0]).toContain(
      "body.pwa-standalone [data-app-shell-root]",
    );
    expect(columnBlock?.[0]).toContain("100dvh");
    expect(columnBlock?.[0]).toContain("100vh");
    expect(columnBlock?.[0]).not.toContain("100lvh");
  });
});

describe("CSS-FIRST contract — media-query lockdown is detection-independent", () => {
  // The installed-PWA lockdown + geometry must NOT depend on the JS-added
  // `body.pwa-standalone` class, because that class does not land on the real
  // iOS PWA (app/main.tsx runs a local setupPlatformStyles that never tags the
  // body). The pure-CSS `@media (display-mode: standalone)` rule PROVABLY
  // matches on device, so it is the source of truth.
  const stylesDir = resolve(process.cwd(), "src/styles");
  const baseCss = readFileSync(resolve(stylesDir, "base.css"), "utf8");
  const stylesCss = readFileSync(resolve(stylesDir, "styles.css"), "utf8");

  /** Extract the body of a `@media ... { ... }` at-rule whose prelude matches
   *  `preludeIncludes` (all substrings) and whose body contains `bodyMarker`.
   *  Balances nested braces so the whole media block (incl. inner rules) is
   *  returned. */
  function mediaBlock(
    css: string,
    preludeIncludes: string[],
    bodyMarker: string,
  ): string | null {
    let i = 0;
    while (true) {
      const at = css.indexOf("@media", i);
      if (at < 0) return null;
      const open = css.indexOf("{", at);
      if (open < 0) return null;
      const prelude = css.slice(at + "@media".length, open);
      // Balance braces from `open` to find the matching close.
      let depth = 0;
      let end = open;
      for (let p = open; p < css.length; p++) {
        if (css[p] === "{") depth++;
        else if (css[p] === "}") {
          depth--;
          if (depth === 0) {
            end = p;
            break;
          }
        }
      }
      const body = css.slice(open + 1, end);
      if (
        preludeIncludes.every((s) => prelude.includes(s)) &&
        body.includes(bodyMarker)
      ) {
        return body;
      }
      i = end + 1;
    }
  }

  it("base.css gates the NON-fixed touch lockdown on display-mode + pointer:coarse (no JS class)", () => {
    const block = mediaBlock(
      baseCss,
      ["display-mode: standalone", "pointer: coarse"],
      "touch-action: pan-x pan-y",
    );
    expect(block).not.toBeNull();
    expect(block ?? "").toContain("touch-action: pan-x pan-y");
    expect(block ?? "").toMatch(/overscroll-behavior:\s*none/);
    expect(block ?? "").toMatch(/overflow:\s*hidden/);
    expect(block ?? "").toMatch(/height:\s*100dvh/);
    // The bare-body lockdown must NOT pin the body fixed (the collapse trigger).
    expect(stripCssComments(block ?? "")).not.toMatch(/position:\s*fixed/);
  });

  it("base.css standalone media prelude also matches fullscreen + guards pointer:coarse", () => {
    const at = baseCss.indexOf(
      "@media all and (display-mode: standalone) and (pointer: coarse)",
    );
    expect(at).toBeGreaterThan(-1);
    const open = baseCss.indexOf("{", at);
    const prelude = baseCss.slice(at + "@media".length, open);
    expect(prelude).toContain("display-mode: standalone");
    expect(prelude).toContain("display-mode: fullscreen");
    // Every branch of the comma prelude must carry the coarse-pointer guard.
    const branches = prelude.split(",");
    for (const branch of branches) {
      expect(branch).toContain("pointer: coarse");
    }
  });

  it("styles.css media block fills #root + shell to the viewport (100dvh, no fixed body)", () => {
    const block = mediaBlock(
      stylesCss,
      ["display-mode: standalone", "pointer: coarse"],
      "[data-app-shell-root]",
    );
    expect(block).not.toBeNull();
    expect(block ?? "").toContain("touch-action: pan-y");
    expect(block ?? "").toMatch(/#root\s*\{[\s\S]*?max-height:\s*100dvh/);
    expect(block ?? "").toMatch(
      /\[data-app-shell-root\]\s*\{[\s\S]*?height:\s*100dvh/,
    );
    // No obsolete large-viewport reclaim, no fixed body geometry.
    expect(block ?? "").not.toContain("100lvh");
    expect(stripCssComments(block ?? "")).not.toMatch(/position:\s*fixed/);
  });
});

describe("App shell column contract — the shell column carries the fill hook", () => {
  // The CSS viewport-fill targets `[data-app-shell-root]`; that hook must exist
  // on the App.tsx shell column or the override matches nothing.
  it("App.tsx tags the shell column with data-app-shell-root", () => {
    const appTsx = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
    expect(appTsx).toContain("data-app-shell-root");
  });
});

describe("Bottom-reclaim mechanism is GONE (regression guard)", () => {
  // The JS `standalone-bottom-reclaim` measurement + `--standalone-bottom-reclaim`
  // var were an 8-deep workaround for the fixed-body ICB collapse. With the body
  // no longer fixed the wallpaper reaches the true bottom on its own, so the
  // whole mechanism is deleted. These guard against it creeping back.
  const uiSrc = resolve(process.cwd(), "src");

  it("the reclaim module no longer exists", () => {
    expect(
      existsSync(resolve(uiSrc, "platform/standalone-bottom-reclaim.ts")),
    ).toBe(false);
  });

  it("no fixed background layer / floor / composer references the reclaim var", () => {
    const files = [
      "App.tsx",
      "backgrounds/ShaderBackground.tsx",
      "backgrounds/ImageBackground.tsx",
      "backgrounds/ProgrammableShaderBackground.tsx",
      "components/shell/ContinuousChatOverlay.tsx",
    ];
    for (const rel of files) {
      const src = readFileSync(resolve(uiSrc, rel), "utf8");
      expect(src, `${rel} must not import the reclaim`).not.toContain(
        "STANDALONE_BOTTOM_RECLAIM_OFFSET",
      );
      expect(src, `${rel} must not read the reclaim var`).not.toContain(
        "--standalone-bottom-reclaim",
      );
    }
  });
});

describe("Composer bottom geometry — full-bleed, keyboard-lift preserved", () => {
  // With the non-fixed body, the `position: fixed` composer overlay's containing
  // block is the true viewport, so at rest it anchors `bottom: 0` and seats at
  // the physical screen bottom — no reclaim offset. The home-indicator clearance
  // is the composer row's own paddingBottom (safe-area-bottom), so buttons stay
  // tappable above the indicator. With the keyboard up, `effectiveKeyboardInset`
  // (visual-viewport delta) is the sole lift path.
  const overlaySrc = readFileSync(
    resolve(process.cwd(), "src/components/shell/ContinuousChatOverlay.tsx"),
    "utf8",
  );
  const layoutSrc = readFileSync(
    resolve(process.cwd(), "src/components/shell/chat-panel-layout.ts"),
    "utf8",
  );

  it("anchors the resting composer at bottom: 0 (keyboard-lift wins when active)", () => {
    expect(overlaySrc).toContain(
      "keyboardLiftActive ? effectiveKeyboardInset : 0",
    );
    expect(overlaySrc).toContain(
      "effectiveKeyboardInset = Math.max(keyboardInset, nativeLift)",
    );
  });

  it("keeps the home-indicator clearance as composer paddingBottom (send button stays tappable)", () => {
    expect(overlaySrc).toContain(
      "max(var(--safe-area-bottom, 0px), var(--android-gesture-inset-bottom, 0px)) + 0.5rem",
    );
  });

  it("bounds the panel height by the visual viewport, not #root/lvh", () => {
    expect(layoutSrc).toContain("viewportH -");
    expect(layoutSrc).not.toContain("100lvh");
    expect(layoutSrc).not.toContain("100dvh");
  });

  it("lifts the composer purely from the visual-viewport keyboard inset (no screen.height reclaim signal)", () => {
    // With the non-fixed body there is no ICB collapse to work around, so the
    // keyboard lift comes solely from the visual-viewport delta — no
    // `screen.height` probe and no reclaim-gated signal.
    expect(overlaySrc).toContain("visualViewport");
    expect(overlaySrc).not.toContain("KEYBOARD_INTRUSION_THRESHOLD_PX");
    expect(overlaySrc).not.toContain("shouldInstallStandaloneBottomReclaim");
  });
});
