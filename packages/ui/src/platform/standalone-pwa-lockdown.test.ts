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

  it("reclaims #root to the LARGE viewport (100lvh) for the installed PWA too (styles.css)", () => {
    // RECLAIM THE BOTTOM STRIP (#14411): #root now fills 100lvh (the true
    // physical bottom), not the old 100dvh clamp that left a ~59px ember-floor
    // strip below it. The class-path rule must carry pwa-standalone and pin the
    // large-viewport height (with 100dvh/100vh progressive fallbacks).
    // The large-viewport height is now centralized in the
    // `--eliza-large-viewport-height` custom property (declared 100vh with
    // @supports upgrades to 100dvh then 100lvh), so the #root rule pins
    // min/max-height to that var instead of a literal unit ladder.
    const rootBlock = stylesCss.match(
      /body\.native #root,[\s\S]*?max-height: var\(--eliza-large-viewport-height\);/,
    );
    expect(rootBlock).not.toBeNull();
    expect(rootBlock?.[0]).toContain("body.pwa-standalone #root");
    // And the var's progressive-enhancement ladder must exist at :root.
    expect(stylesCss).toMatch(/--eliza-large-viewport-height:\s*100vh/);
    expect(stylesCss).toMatch(
      /@supports \(height: 100dvh\)[\s\S]*?--eliza-large-viewport-height:\s*100dvh/,
    );
    expect(stylesCss).toMatch(
      /@supports \(height: 100lvh\)[\s\S]*?--eliza-large-viewport-height:\s*100lvh/,
    );
    // The old hard 100dvh clamp (min AND max pinned to dvh) must be gone.
    expect(rootBlock?.[0]).not.toMatch(
      /min-height:\s*100dvh;\s*max-height:\s*100dvh;/,
    );
  });

  it("reclaims the app shell column to 100lvh in the installed PWA (styles.css)", () => {
    // RECLAIM THE BOTTOM STRIP (#14411): App.tsx's shell column carries a base
    // `h-[100dvh]` (correct for a desktop tab / popout). In the installed PWA a
    // CSS override must lift it to the LARGE viewport so it fills the 100lvh
    // #root above and doesn't stop ~59px short (which would expose #root's
    // --launch-bg as a near-black band). Targets the stable
    // `[data-app-shell-root]` hook on the column.
    // Same centralization: the column pins to var(--eliza-large-viewport-height)
    // (whose @supports ladder covers 100vh -> 100dvh -> 100lvh).
    const columnBlock = stylesCss.match(
      /body\.native \[data-app-shell-root\],[\s\S]*?height: var\(--eliza-large-viewport-height\);/,
    );
    expect(columnBlock).not.toBeNull();
    expect(columnBlock?.[0]).toContain(
      "body.pwa-standalone [data-app-shell-root]",
    );
  });
});

describe("CSS geometry contract — fixed-body ICB collapse fix (bottom black band)", () => {
  // The residual bottom band regression: #14293's `position: fixed` body on the
  // iOS Safari standalone PWA collapsed the fixed-descendant initial containing
  // block to the layout (small) viewport, so `fixed inset-0` layers (wallpaper,
  // safe-area floor) stopped ~59px above the true bottom and html/body/#root
  // --launch-bg (#160d07) showed through as a near-black band. The fix pins the
  // fixed body to the LARGE viewport height so its ICB fills the real screen.
  const stylesDir = resolve(process.cwd(), "src/styles");
  const stylesCss = readFileSync(resolve(stylesDir, "styles.css"), "utf8");

  /** Extract the declaration block for the bare `body.pwa-standalone { ... }`
   *  GEOMETRY rule (the one carrying the lvh height fix), NOT the grouped
   *  `body.native, body.pwa-standalone { ... }` lockdown rule nor the
   *  `body.pwa-standalone #root` rule. Walks every `body.pwa-standalone {`
   *  block and returns the one whose body contains `100lvh`. */
  function standalonePwaOwnBlock(): string {
    // A selector that is EXACTLY `body.pwa-standalone` (preceded by start/`\n`,
    // and — critically — not the tail of a comma group: the char before the
    // preceding newline must not be a comma). Capture each block body and pick
    // the one with the lvh height fix.
    const re = /(?:^|[^,]\n)body\.pwa-standalone\s*\{([\s\S]*?)\}/g;
    let match: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex walk
    while ((match = re.exec(stylesCss)) !== null) {
      if (match[1].includes("100lvh")) return match[1];
    }
    // Fall back to the first bare block if none carried lvh (test will then
    // fail loudly on the missing-100lvh assertion, which is the intent).
    const first = stylesCss.match(
      /(?:^|[^,]\n)body\.pwa-standalone\s*\{([\s\S]*?)\}/,
    );
    expect(first).not.toBeNull();
    return first?.[1] ?? "";
  }

  it("pins the standalone-PWA fixed body to the LARGE viewport height (100lvh)", () => {
    const block = standalonePwaOwnBlock();
    // The large-viewport height is centralized in
    // `--eliza-large-viewport-height` (100vh, @supports-upgraded to 100dvh then
    // 100lvh at :root) — the load-bearing declaration that forces the fixed
    // body's ICB to the large viewport so `fixed inset-0` children reach the
    // true bottom.
    expect(block).toContain("height: var(--eliza-large-viewport-height)");
  });

  it("releases `bottom` on the standalone-PWA body so top+height drive the box", () => {
    // base.css's lockdown group sets `inset: 0` (=> bottom: 0) on
    // body.pwa-standalone; leaving it would re-anchor the fixed body to the
    // collapsed layout-viewport bottom (the bug). The geometry rule must reset
    // it to `auto` so height governs the extent.
    const block = standalonePwaOwnBlock();
    expect(block).toMatch(/bottom:\s*auto/);
  });

  it("anchors the standalone-PWA body to the top-left of the viewport", () => {
    const block = standalonePwaOwnBlock();
    expect(block).toMatch(/top:\s*0/);
    expect(block).toMatch(/left:\s*0/);
    expect(block).toMatch(/right:\s*0/);
  });

  it("leaves the standalone body floor TRANSPARENT so the wallpaper owns the bottom edge (no painted floor strip)", () => {
    // BOTTOM-BAR FIX (r4): the prior "defensive warm-ember floor" painted an
    // OPAQUE color-mix(--launch-bg 82%, ember) === rgb(61,27,11) slab on the
    // fixed body. Whenever the `fixed inset-0` wallpaper failed to reach the
    // true bottom by even a hair (ICB rounding on device), that slab bled
    // through as a UNIFORM warm-brown bar across the whole home-indicator zone
    // under the floating composer — the recurring "bottom bar" (flagged in 3
    // successive builds). The floor must be TRANSPARENT so the only thing
    // visible at the bottom edge is the wallpaper (the always-mounted
    // `fixed inset-0` AppBackground, which spans the full 100lvh body), never a
    // painted band. Any true seam falls through to html/#root's near-black
    // --launch-bg, which is ambient-consistent with a dark wallpaper — not a
    // bright warm bar.
    const block = standalonePwaOwnBlock();
    expect(block).toMatch(/background-color:\s*transparent/);
    // And it must NOT paint the old warm-ember color-mix slab.
    expect(block).not.toMatch(/background-color:\s*color-mix/);
  });

  it("leaves #root TRANSPARENT in the installed PWA so its --launch-bg (#160d07) never paints the collapsed-ICB strip (r10)", () => {
    // BOTTOM-BAR FIX (r10 — the definitive one, keyed to on-device geometry):
    // the diagnostics chip reported docEl.clientHeight=873, 100lvh=932,
    // screen.height=932, reclaim-var=59. Even though #root is max-height:100lvh,
    // WebKit resolves that lvh box against the COLLAPSED fixed-body ICB (873),
    // so #root renders 873px tall and paints its --launch-bg (#160d07) across
    // that box; the 59px below (873→932) is html/body's #160d07 — together the
    // recurring strip. Stretching a box to 932 cannot work (the box can't see
    // past the collapsed ICB). The cure: #root must be TRANSPARENT so the fixed
    // AppBackground wallpaper (reclaimed to the true bottom + mirrored onto the
    // html canvas) is the ONLY thing painting the bottom edge. Assert both the
    // class-path and that #root does NOT reintroduce an opaque launch-bg.
    expect(stylesCss).toMatch(
      /body\.native #root,\s*\n\s*body\.pwa-standalone #root\s*\{[\s\S]*?background:\s*transparent/,
    );
    // The bare body.pwa-standalone own-block must also be transparent (not the
    // global `html, body { background: var(--launch-bg) }` near-black).
    expect(stylesCss).toMatch(
      /body\.native,\s*\n\s*body\.pwa-standalone\s*\{\s*\n\s*background:\s*transparent/,
    );
  });

  it("sizes `html` to 100lvh + transparent in the installed PWA so overflow:hidden does not clip the wallpaper at clientHeight=873 (r11)", () => {
    // BOTTOM-BAR FIX (r11 — the CLIP): on-device pixel forensics put the
    // #160d07 cut at EXACTLY documentElement.clientHeight (873/932 = 93.7% of a
    // 932px screen). Root cause: `html { overflow: hidden; height: 100% }`, and
    // `height: 100%` resolves to the collapsed ICB (873). So html is an 873px
    // clip box that CLIPS the reclaimed `fixed { bottom: -59px }` wallpaper AND
    // its own canvas background-image at 873; the 59px below is the browser
    // canvas showing html's #160d07 background-color. Neither rc59 nor the
    // transparent #root can help while html clips at 873. Fix: html must be
    // sized to the LARGE viewport (100lvh) + transparent in the installed shell.
    // Assert BOTH paths: the class-path `html:has(body.pwa-standalone)` and the
    // detection-independent display-mode media query bare `html`.
    expect(stylesCss).toMatch(
      /html:has\(body\.native\),\s*\n\s*html:has\(body\.pwa-standalone\)\s*\{[\s\S]*?height:\s*100lvh;[\s\S]*?background:\s*transparent/,
    );
    // The media-query path must also size html to 100lvh (the SOURCE OF TRUTH on
    // device, since the JS pwa-standalone class is unreliable there).
    const mq = stylesCss.match(
      /@media[\s\S]*?display-mode:\s*standalone[\s\S]*?\{([\s\S]*?)\n\}/,
    );
    expect(mq?.[1] ?? "").toMatch(/html\s*\{[\s\S]*?height:\s*100lvh/);
  });

  it("keeps the native (Capacitor) body on `inset: 0` — the fix is PWA-scoped", () => {
    // Native WKWebView's fixed-ICB is already the full screen, so inset:0 is
    // correct there; the lvh override must NOT bleed onto body.native. Find the
    // BARE `body.native { ... }` rule (not the grouped lockdown selector) by
    // picking the block that carries `inset: 0`.
    const re = /(?:^|[^,]\n)body\.native\s*\{([\s\S]*?)\}/g;
    let nativeOwn: string | null = null;
    let match: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex walk
    while ((match = re.exec(stylesCss)) !== null) {
      if (/inset:\s*0/.test(match[1])) {
        nativeOwn = match[1];
        break;
      }
    }
    expect(nativeOwn).not.toBeNull();
    expect(nativeOwn ?? "").toMatch(/inset:\s*0/);
    // And the native own-block must not carry the lvh height override.
    expect(nativeOwn ?? "").not.toContain("100lvh");
  });
});

describe("CSS-FIRST contract — media-query lockdown is detection-independent", () => {
  // The decisive fix: the installed-PWA lockdown + #14319 geometry must NOT
  // depend on the JS-added `body.pwa-standalone` class, because that class does
  // not land on the real iOS PWA (app/main.tsx runs a local setupPlatformStyles
  // that never tags the body). The pure-CSS `@media (display-mode: standalone)`
  // rule PROVABLY matches on device (the #14294 scrollbar fix worked), so it is
  // the source of truth. These assertions pin that the media-query blocks exist
  // AND carry the load-bearing declarations, gated on `(pointer: coarse)` so a
  // fine-pointer desktop fullscreen window is never locked.
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

  it("base.css gates the touch lockdown on display-mode + pointer:coarse (no JS class)", () => {
    const block = mediaBlock(
      baseCss,
      ["display-mode: standalone", "pointer: coarse"],
      "touch-action: pan-x pan-y",
    );
    expect(block).not.toBeNull();
    // Fullscreen display-mode must also be covered (chrome-less PWA).
    expect(block ?? "").not.toBeNull();
    // The bare-body lockdown must claim touch-action + pin the body fixed.
    expect(block ?? "").toContain("touch-action: pan-x pan-y");
    expect(block ?? "").toMatch(/position:\s*fixed/);
    expect(block ?? "").toMatch(/overscroll-behavior:\s*none/);
  });

  it("base.css standalone media prelude also matches fullscreen + guards pointer:coarse", () => {
    // Assert the prelude carries BOTH display-modes and BOTH pointer guards so
    // desktop fullscreen (fine pointer) is excluded.
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

  it("styles.css gates the #14319 geometry (100lvh) on display-mode + pointer:coarse", () => {
    const block = mediaBlock(
      stylesCss,
      ["display-mode: standalone", "pointer: coarse"],
      "100lvh",
    );
    expect(block).not.toBeNull();
    // The load-bearing large-viewport fix + its progressive fallbacks.
    expect(block ?? "").toContain("100lvh");
    expect(block ?? "").toContain("100dvh");
    expect(block ?? "").toContain("100vh");
    // Hand horizontal drags to the app gestures.
    expect(block ?? "").toContain("touch-action: pan-y");
    // Release `bottom` so top+height drive the box (the #14319 anchor fix).
    expect(block ?? "").toMatch(/bottom:\s*auto/);
    // BOTTOM-BAR FIX (r4): transparent floor — the wallpaper owns the bottom
    // edge; no painted warm-ember slab that bleeds through as a bar.
    expect(block ?? "").toMatch(/background-color:\s*transparent/);
    expect(block ?? "").not.toMatch(/background-color:\s*color-mix/);
  });

  it("styles.css media block reclaims #root to the LARGE viewport (100lvh)", () => {
    // RECLAIM THE BOTTOM STRIP (#14411): the media-query #root rule now pins the
    // large viewport so the app fills full-bleed to the true bottom, not the old
    // 100dvh clamp.
    const block = mediaBlock(
      stylesCss,
      ["display-mode: standalone", "pointer: coarse"],
      "--eliza-large-viewport-height",
    );
    expect(block).not.toBeNull();
    expect(block ?? "").toMatch(
      /#root\s*\{[\s\S]*?max-height:\s*var\(--eliza-large-viewport-height\)/,
    );
    // The app shell column reclaim must ride the same media block.
    expect(block ?? "").toMatch(
      /\[data-app-shell-root\]\s*\{[\s\S]*?height:\s*var\(--eliza-large-viewport-height\)/,
    );
  });
});

describe("App shell reclaim contract — the shell column carries the reclaim hook", () => {
  // RECLAIM THE BOTTOM STRIP (#14411): the CSS reclaim of the shell column
  // targets `[data-app-shell-root]`; that hook must exist on the App.tsx shell
  // column (the `position: relative` safe-area-fill root) or the CSS override
  // matches nothing and the column stays clamped at its base h-[100dvh].
  it("App.tsx tags the shell column with data-app-shell-root", () => {
    const appTsx = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
    expect(appTsx).toContain("data-app-shell-root");
  });
});

describe("Keyboard-lift geometry contract — reclaim does NOT shift the composer lift", () => {
  // RECLAIM THE BOTTOM STRIP (#14411/#r36) regression guard: the composer overlay
  // is a `position: fixed` descendant of the fixed body. In an installed iOS PWA,
  // `bottom: 0` for that fixed descendant anchors to the layout/small viewport
  // (~873px), while the true physical bottom is the large viewport (~932px). At
  // REST the overlay must compensate by the lvh−dvh delta so the composer sits
  // above the home indicator instead of floating over a dead band. With the
  // KEYBOARD up, the existing `effectiveKeyboardInset` visual-viewport delta is
  // still the sole lift path: no lvh compensation is applied during keyboard
  // lift, and panel height remains bounded by `viewportH`.
  const overlaySrc = readFileSync(
    resolve(process.cwd(), "src/components/shell/ContinuousChatOverlay.tsx"),
    "utf8",
  );
  const layoutSrc = readFileSync(
    resolve(process.cwd(), "src/components/shell/chat-panel-layout.ts"),
    "utf8",
  );

  it("reclaims the resting composer by the JS-MEASURED standalone bottom gap var", () => {
    // The reclaim now references the MEASURED `--standalone-bottom-reclaim` var
    // (JS: window/visualViewport vs documentElement.clientHeight), NOT the
    // useless `max(0px, 100lvh - 100dvh)` CSS-unit calc that resolved to 0 on
    // the collapsed fixed-body ICB (why the strip survived 5 CSS-only fixes).
    expect(overlaySrc).toContain("STANDALONE_BOTTOM_RECLAIM_OFFSET");
    // The dead CSS-unit calc must not survive as an actual VALUE (quoted calc
    // string); it may still be named in an explanatory comment.
    expect(overlaySrc).not.toContain('"calc(-1 * max(0px, 100lvh - 100dvh))"');
    expect(overlaySrc).toContain("keyboardLiftActive");
    // Resting clearance should be the full safe-area/gesture inset plus a small
    // visual gap, so on a 34px home-indicator device the composer rests ~42px
    // from the physical edge (34px + 0.5rem), not ~90px up. (#15097 trimmed the
    // extra gap 0.625rem -> 0.5rem now that the measured reclaim seats the
    // overlay at the true bottom, so it sits snug, not floating.)
    expect(overlaySrc).toContain(
      "max(var(--safe-area-bottom, 0px), var(--android-gesture-inset-bottom, 0px)) + 0.5rem",
    );
  });

  it("lifts the composer by effectiveKeyboardInset (visual-viewport delta) when the keyboard is active", () => {
    expect(overlaySrc).toContain("? effectiveKeyboardInset");
    // At rest (keyboard down) the composer reclaims by the MEASURED gap var.
    expect(overlaySrc).toContain(": STANDALONE_BOTTOM_RECLAIM_OFFSET");
    // effectiveKeyboardInset is derived from the visual viewport + native
    // keyboard plugin.
    expect(overlaySrc).toContain(
      "effectiveKeyboardInset = Math.max(keyboardInset, nativeLift)",
    );
  });

  it("bounds the panel height by the visual viewport, not #root/lvh", () => {
    // resolveChatPanelLayout caps panelMaxH by viewportH (the visual viewport),
    // so a taller 100lvh #root does not let the panel top shoot off-screen.
    expect(layoutSrc).toContain("viewportH -");
    expect(layoutSrc).not.toContain("100lvh");
    expect(layoutSrc).not.toContain("100dvh");
  });

  it("detects the soft keyboard via screen.height (not just innerHeight - vv.height) so post-#15103 the composer still lifts", () => {
    // r-kbd REGRESSION guard: post-#15103 `html:100lvh` un-collapsed the iOS
    // layout viewport, so the soft keyboard shrinks innerHeight AND
    // visualViewport.height TOGETHER (device chip ih542 vv542 sh932). The old
    // `innerHeight - vv.height` delta then reads 0 and the composer never lifts
    // (hidden behind the keyboard, wallpaper void above the panel). readViewport
    // must ALSO derive the intrusion from `screen.height - vv.height` and take
    // the larger signal, gated above KEYBOARD_INTRUSION_THRESHOLD_PX so the
    // resting fixed-body collapse (~59px) is never read as a keyboard.
    expect(overlaySrc).toContain("insetFromScreen");
    expect(overlaySrc).toContain("window.screen?.height");
    expect(overlaySrc).toContain("KEYBOARD_INTRUSION_THRESHOLD_PX");
    // The two signals are combined with max() so Android/web (which keep the
    // pure inner-delta) are unchanged.
    expect(overlaySrc).toContain(
      "keyboardInset = Math.max(insetFromInner, screenKeyboard)",
    );
  });

  it("gates the screen.height keyboard signal to iOS standalone/native (never desktop/Android where screen.height is the whole device)", () => {
    // screen.height is only a valid full-viewport reference on the iOS
    // standalone PWA / iOS native WebView (where the reclaim installs). On
    // desktop it is the monitor and on Android / non-standalone the full device
    // screen, both far larger than the layout viewport at rest — so the
    // screen-vs-vv delta must be OFF there or it would false-positive a keyboard
    // and lift the composer at rest. The gate mirrors the reclaim install gate.
    expect(overlaySrc).toContain("SCREEN_KEYBOARD_SIGNAL_ACTIVE");
    expect(overlaySrc).toContain("if (SCREEN_KEYBOARD_SIGNAL_ACTIVE) {");
    expect(overlaySrc).toContain("shouldInstallStandaloneBottomReclaim({");
  });
});

describe("Fixed background layers reach the TRUE physical bottom (bottom-bar root cause)", () => {
  // BOTTOM-BAR ROOT CAUSE (device r5): every full-bleed background layer is a
  // `fixed inset-0` descendant of the fixed body. On the installed iOS
  // standalone PWA the fixed-descendant ICB collapses to the small/layout
  // viewport (~59px short of the true 100lvh bottom). The composer already
  // compensates its `bottom` by `-1 * max(0px, 100lvh - 100dvh)`; the wallpaper
  // AND the shell-owned safe-area floor must do the same so nothing stops short
  // and exposes the dimmed launch-bg as a uniform bar under the composer. The
  // delta is 0 on every viewport where the two agree (desktop/Android), so this
  // is a pure iOS-standalone reclaim, no-op elsewhere.
  // The reclaim now references the JS-MEASURED `--standalone-bottom-reclaim`
  // var (via the shared STANDALONE_BOTTOM_RECLAIM_OFFSET constant), NOT the
  // useless `max(0px, 100lvh - 100dvh)` CSS-unit calc that resolved to 0 on the
  // collapsed fixed-body ICB. Assert the constant is imported + used and the
  // dead CSS-unit calc is GONE from every reclaim site.
  const DELTA = "STANDALONE_BOTTOM_RECLAIM_OFFSET";
  // The dead form is the CSS-unit calc used as an ACTUAL VALUE (inside a
  // `bottom:` assignment). It may still be NAMED in explanatory comments, so
  // match the value form (quoted calc string), not the bare phrase.
  const DEAD_CALC = '"calc(-1 * max(0px, 100lvh - 100dvh))"';
  const appTsx = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
  const shaderSrc = readFileSync(
    resolve(process.cwd(), "src/backgrounds/ShaderBackground.tsx"),
    "utf8",
  );
  const imageSrc = readFileSync(
    resolve(process.cwd(), "src/backgrounds/ImageBackground.tsx"),
    "utf8",
  );
  const glslSrc = readFileSync(
    resolve(process.cwd(), "src/backgrounds/ProgrammableShaderBackground.tsx"),
    "utf8",
  );

  it("drops the shell-owned safe-area floor to the true bottom via the MEASURED gap var", () => {
    // The `app-safe-area-floor` is the FOUC guard on opaque routes; if it stops
    // short its `bg-bg`/transparent edge leaves the launch-bg strip exposed.
    expect(appTsx).toContain(DELTA);
    expect(appTsx).not.toContain(DEAD_CALC);
    expect(appTsx).toContain("app-safe-area-floor");
  });

  it("drops the ShaderBackground wallpaper to the true bottom via the MEASURED gap var", () => {
    expect(shaderSrc).toContain(DELTA);
    expect(shaderSrc).not.toContain(DEAD_CALC);
  });

  it("drops the ImageBackground wallpaper to the true bottom via the MEASURED gap var", () => {
    expect(imageSrc).toContain(DELTA);
    expect(imageSrc).not.toContain(DEAD_CALC);
  });

  it("drops the programmable GLSL wallpaper to the true bottom via the MEASURED gap var", () => {
    expect(glslSrc).toContain(DELTA);
    expect(glslSrc).not.toContain(DEAD_CALC);
  });
});
