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
 * `position: fixed; inset: 0`; (3) `html` is sized to the LARGE viewport
 * (`100lvh`) + transparent in the installed shell so its `overflow: hidden` clip
 * box reaches the true screen bottom (the r12 CLIP fix); (4) the JS-measured
 * bottom-reclaim IS PRESENT and install-guarded on the iOS standalone/native path.
 *
 * NOTE on the CLIP (the root cause that survived an 8-deep reclaim pile): the
 * strip is NOT primarily a fixed-descendant ICB problem — device pixel forensics
 * put the cut at EXACTLY documentElement.clientHeight (873 = 93.7% of the 932
 * screen). The ROOT element `html` is `overflow: hidden; height: 100%`, and
 * `height: 100%` resolves to the collapsed 873 ICB, so html is an 873px CLIP BOX
 * that cuts off BOTH the reclaimed `fixed inset-0 { bottom: -reclaim }` wallpaper
 * extension AND html's own canvas paint at 873; the 59px below (873→932) shows
 * html's own background-color as the strip. Contrary to an earlier note here,
 * `100lvh` does NOT equal `100dvh` on device — the device chip proves
 * `100lvh 932` while `100dvh 873` and `screen.height 932`. So sizing `html`
 * itself to `100lvh` (932) is what un-clips the wallpaper (test 3). Once html is
 * 100lvh WebKit un-collapses the ICB (`innerHeight` 873→932), so the JS reclaim
 * (test 4) measures `screen.height - innerHeight = 0` and self-zeroes — the two
 * coexist as belt-and-suspenders. Removing either regressed the bottom bar on
 * device while jsdom stayed green, so the guards below make that a red CI instead
 * of a silent device regression.
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

  it("sizes the html CLIP BOX to 100lvh + transparent on the class path (the r12 bottom-bar CLIP fix)", () => {
    // The class-path twin of the media-block rule: `html { overflow: hidden;
    // height: 100% }` makes html an 873px clip box on the collapsed iOS PWA ICB,
    // cutting off the reclaimed fixed wallpaper (873→932) and painting the 59px
    // strip from html's own background-color. Sizing `html` to the LARGE viewport
    // (100lvh = the true 932 per the device chip `100lvh 932`) makes its clip box
    // + canvas reach the physical bottom; transparent so the un-clipped wallpaper
    // owns the edge. Matches both the native and pwa-standalone class selectors.
    const htmlBlock = stylesCss.match(
      /html:has\(body\.native\),[\s\S]*?background:\s*transparent;[\s\S]*?\}/,
    );
    expect(htmlBlock).not.toBeNull();
    expect(htmlBlock?.[0]).toContain("html:has(body.pwa-standalone)");
    // The large viewport unit resolving to the true 932 screen.
    expect(htmlBlock?.[0]).toContain("100lvh");
    // Progressive-enhancement fallback stack.
    expect(htmlBlock?.[0]).toContain("100dvh");
    expect(htmlBlock?.[0]).toContain("100vh");
    expect(htmlBlock?.[0]).toMatch(/background:\s*transparent/);
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
    // #root + the app-shell column fill the viewport at 100dvh (the app column
    // is 873 on the collapsed device; that is correct — it is the CLIP BOX on
    // `html` that must reach the true screen, not these). No fixed body geometry.
    expect(block ?? "").toMatch(/#root\s*\{[\s\S]*?max-height:\s*100dvh/);
    expect(block ?? "").toMatch(
      /\[data-app-shell-root\]\s*\{[\s\S]*?height:\s*100dvh/,
    );
    // #root must NOT itself carry the large-viewport unit (it stays 100dvh).
    const rootRule = (block ?? "").match(/body #root\s*\{[\s\S]*?\}/);
    expect(rootRule?.[0] ?? "").not.toContain("100lvh");
    expect(stripCssComments(block ?? "")).not.toMatch(/position:\s*fixed/);
  });

  it("styles.css media block sizes the html CLIP BOX to 100lvh + transparent (the r12 bottom-bar CLIP fix)", () => {
    // ROOT CAUSE of the recurring home-indicator black strip (device pixel
    // forensics: cut at 873/932 = 93.7%): `html { overflow: hidden; height: 100% }`
    // resolves `height: 100%` against the collapsed fixed-body ICB (873) on the
    // installed iOS PWA, making `html` an 873px CLIP BOX that cuts off BOTH the
    // reclaimed `fixed inset-0 { bottom: -reclaim }` wallpaper extension AND html's
    // own canvas paint at 873 — the 59px below (873→932) is html's own
    // background-color showing as the strip. No JS reclaim or #root transparency can
    // reach past an 873px html clip. The cure (device-verified in f030dbbd40b, then
    // dropped by the 100dvh rewrite): size `html` itself to the LARGE viewport
    // (100lvh = the true 932 per the device chip) so its clip box + canvas reach the
    // physical bottom, transparent so the un-clipped wallpaper owns the edge. This is
    // gated in the display-mode media block because the JS `body.pwa-standalone`
    // class does not land on device — the media query is the source of truth.
    // Deleting this rule returns the bottom bar on device: keep it RED in CI.
    const block = mediaBlock(
      stylesCss,
      ["display-mode: standalone", "pointer: coarse"],
      "[data-app-shell-root]",
    );
    expect(block).not.toBeNull();
    // Match the `html { ... }` rule inside the media body (a leading comment may
    // precede it). `html` here is the bare element selector, distinct from the
    // `body #root` / `[data-app-shell-root]` rules.
    const htmlRule = (block ?? "").match(/\bhtml\s*\{[^}]*\}/);
    expect(htmlRule).not.toBeNull();
    // The large viewport unit that resolves to the true 932 screen (chip: 100lvh 932).
    expect(htmlRule?.[0] ?? "").toContain("100lvh");
    // Progressive-enhancement fallback stack for engines without lvh.
    expect(htmlRule?.[0] ?? "").toContain("100dvh");
    expect(htmlRule?.[0] ?? "").toContain("100vh");
    // Transparent so the un-clipped fixed wallpaper owns the bottom edge, not
    // html's launch-bg.
    expect(htmlRule?.[0] ?? "").toMatch(/background:\s*transparent/);
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

describe("JS-measured bottom reclaim is PRESENT and INSTALL-GUARDED (durable device contract)", () => {
  // DEVICE TRUTH (why this must exist — proven over N regressions): on the
  // installed iOS standalone PWA the layout viewport collapses to the small box
  // (`documentElement.clientHeight`/`innerHeight` = 873 while the physical
  // `screen.height` = 932). Note the device chip proves `100lvh 932` (the LARGE
  // viewport DOES see the true screen) while `100dvh 873` — which is exactly why
  // the r12 CLIP fix sizes `html` to `100lvh` to un-clip the wallpaper. This JS
  // reclaim is the belt-and-suspenders twin: it re-seats the `fixed` composer
  // overlay whose `bottom: 0` would otherwise float ~59px UP over the dead strip.
  // The runtime value that still exposes the true 932 screen regardless of ICB
  // state is `window.screen.height`, so the reclaim is measured in JS
  // (`screen.height - layout`) and published as `--standalone-bottom-reclaim`.
  // Once `html` is 100lvh the ICB un-collapses (`innerHeight` 873→932) and this
  // reclaim self-zeroes — the two mechanisms do not fight.
  //
  // These tests PIN that mechanism in place. The install-guard test below is the
  // load-bearing one: it turns a future "just delete the JS reclaim, CSS is
  // enough" refactor into a RED CI instead of a silent on-device regression
  // (which is exactly how the bug came back last time — every jsdom test stayed
  // green while the device strip returned). Regression chip for the last round:
  // `ih873 vv873 ce873 sh932 rc? lv932 dv873` on develop tip 2fdf9dd172.
  const uiSrc = resolve(process.cwd(), "src");

  it("the reclaim module EXISTS (it is the device-proven cure, not a workaround to delete)", () => {
    expect(
      existsSync(resolve(uiSrc, "platform/standalone-bottom-reclaim.ts")),
    ).toBe(true);
  });

  it("init.ts INSTALLS the reclaim on the iOS standalone/native path (removal => red CI, not a silent device regression)", () => {
    // The single load-bearing invariant. platform/init.ts must (a) import the
    // installer + its gate and (b) call installStandaloneBottomReclaim() behind
    // shouldInstallStandaloneBottomReclaim(). If a sweep drops this call, the
    // wallpaper/composer stop reclaiming and the bottom bar returns on device —
    // this test fails FIRST so the removal never ships silently.
    const initSrc = readFileSync(resolve(uiSrc, "platform/init.ts"), "utf8");
    expect(initSrc, "init.ts must import the installer").toContain(
      "installStandaloneBottomReclaim",
    );
    expect(initSrc, "init.ts must import the install gate").toContain(
      "shouldInstallStandaloneBottomReclaim",
    );
    // The installer is called behind the gate (not merely imported): assert the
    // gate wraps the install call within setupPlatformStyles.
    const gatedInstall =
      /shouldInstallStandaloneBottomReclaim\(\{[\s\S]*?\}\)[\s\S]*?\)\s*\{[\s\S]*?installStandaloneBottomReclaim\(\)/;
    expect(
      gatedInstall.test(initSrc),
      "init.ts must call installStandaloneBottomReclaim() inside the shouldInstall gate",
    ).toBe(true);
  });

  it("the platform barrel re-exports the reclaim API (consumers resolve it)", () => {
    const indexSrc = readFileSync(resolve(uiSrc, "platform/index.ts"), "utf8");
    expect(indexSrc).toContain("STANDALONE_BOTTOM_RECLAIM_OFFSET");
    expect(indexSrc).toContain("installStandaloneBottomReclaim");
  });

  // ===================================================================
  // THE REAL-CHAIN GUARD (#15178). The `init.ts` test above pins the ui
  // `setupPlatformStyles`, but the installed iOS standalone PWA does NOT boot
  // through that function — `packages/app/src/main.tsx` defines and calls its
  // OWN local `setupPlatformStyles()` (the ui one is only reachable from unit
  // tests). #15178's WIP (f903c59) dropped the installer from that LOCAL
  // function and the "restore" landed only in the orphaned ui copy, so the
  // installer never ran on device (chip: `rc?` / `rcw:off`) while every jsdom
  // test above stayed green. These assertions read the ACTUAL app entry file so
  // an orphaned installer turns CI RED at the real boot path, not just in the
  // ui-only copy. THIS is the test that would have caught the regression.
  const appMainPath = resolve(process.cwd(), "../app/src/main.tsx");

  it("the app entry (main.tsx) EXISTS and is the file under contract", () => {
    expect(
      existsSync(appMainPath),
      "packages/app/src/main.tsx must exist — it is the real installed-PWA boot path",
    ).toBe(true);
  });

  it("app/main.tsx IMPORTS the reclaim installer + gate (the real boot path resolves them)", () => {
    const mainSrc = readFileSync(appMainPath, "utf8");
    expect(
      mainSrc,
      "main.tsx must import installStandaloneBottomReclaim (else the installer is orphaned on the live entry path — #15178)",
    ).toContain("installStandaloneBottomReclaim");
    expect(
      mainSrc,
      "main.tsx must import shouldInstallStandaloneBottomReclaim (the platform gate)",
    ).toContain("shouldInstallStandaloneBottomReclaim");
    expect(
      mainSrc,
      "main.tsx must import clearStandaloneBottomReclaim (the non-standalone hard-0 branch)",
    ).toContain("clearStandaloneBottomReclaim");
  });

  it("app/main.tsx CALLS the installer behind the gate INSIDE its local setupPlatformStyles (removal => red CI, not a silent device regression)", () => {
    const mainSrc = readFileSync(appMainPath, "utf8");
    // The gate must wrap the install call (not merely import it): same invariant
    // the init.ts test pins, but on the file that actually runs on device.
    const gatedInstall =
      /shouldInstallStandaloneBottomReclaim\(\{[\s\S]*?\}\)[\s\S]*?\)\s*\{[\s\S]*?installStandaloneBottomReclaim\(\)/;
    expect(
      gatedInstall.test(mainSrc),
      "main.tsx must call installStandaloneBottomReclaim() inside the shouldInstall gate (this is the #15178 load-bearing line on the REAL boot path)",
    ).toBe(true);
    // ...and the else branch clears on non-standalone surfaces.
    expect(
      mainSrc,
      "main.tsx must clear the reclaim var on the non-standalone branch",
    ).toContain("clearStandaloneBottomReclaim()");
  });

  it("the installer + gate live INSIDE the local setupPlatformStyles that main() invokes (tree-shake / orphan proof)", () => {
    const mainSrc = readFileSync(appMainPath, "utf8");
    // Isolate the local setupPlatformStyles body and assert the install gate is
    // WITHIN it — so a future refactor cannot move the call out of the function
    // that the boot path actually calls and re-orphan the installer.
    const fnMatch = mainSrc.match(
      /function setupPlatformStyles\(\)\s*:\s*void\s*\{([\s\S]*?)\n\}/,
    );
    expect(
      fnMatch,
      "main.tsx must define a local setupPlatformStyles() — the function main() calls on the PWA boot path",
    ).not.toBeNull();
    const body = fnMatch?.[1] ?? "";
    expect(
      body,
      "installStandaloneBottomReclaim() must be called INSIDE main.tsx's local setupPlatformStyles (not orphaned elsewhere)",
    ).toContain("installStandaloneBottomReclaim(");
    expect(
      body,
      "the platform gate must guard the install INSIDE setupPlatformStyles",
    ).toContain("shouldInstallStandaloneBottomReclaim(");
    // And that function is actually invoked on the boot path (not just defined).
    expect(
      mainSrc.match(/\n\s*setupPlatformStyles\(\);/g)?.length ?? 0,
      "main() must call setupPlatformStyles() on the boot path",
    ).toBeGreaterThan(0);
  });

  it("the reclaim module exposes the wiring witness (rcw:on/off/clear) for device diagnostics", () => {
    const reclaimSrc = readFileSync(
      resolve(uiSrc, "platform/standalone-bottom-reclaim.ts"),
      "utf8",
    );
    // The chip must be able to distinguish "installer never ran" (rcw:off, the
    // #15178 signature) from "installer ran, measured 0" (rcw:on, rc0).
    expect(reclaimSrc).toContain("getStandaloneBottomReclaimState");
    const badgeSrc = readFileSync(
      resolve(uiSrc, "components/shell/BuildBadge.tsx"),
      "utf8",
    );
    expect(
      badgeSrc,
      "the build-badge chip must surface the reclaim wiring state (rcw) so device debugging is unambiguous",
    ).toContain("getStandaloneBottomReclaimState");
  });

  it("the composer overlay applies the measured reclaim offset at rest", () => {
    const overlaySrc = readFileSync(
      resolve(uiSrc, "components/shell/ContinuousChatOverlay.tsx"),
      "utf8",
    );
    // The resting `bottom` uses the measured offset (keyboard-lift wins when up).
    expect(overlaySrc).toContain("STANDALONE_BOTTOM_RECLAIM_OFFSET");
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

  it("anchors the resting composer at the measured reclaim offset (keyboard-lift wins when active)", () => {
    // At rest the composer drops by the JS-measured collapse gap so it seats at
    // the TRUE physical bottom (not 59px up over the dead strip). When the
    // keyboard is up, effectiveKeyboardInset owns the lift instead.
    expect(overlaySrc).toContain(
      "keyboardLiftActive\n          ? effectiveKeyboardInset\n          : STANDALONE_BOTTOM_RECLAIM_OFFSET",
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

  it("detects the keyboard via the screen.height signal, gated to the reclaim surface (#15136 keyboard geometry)", () => {
    // Post-#15103 the soft keyboard shrinks innerHeight AND visualViewport
    // together on the iOS standalone PWA (chip `ih542 vv542 sh932`), so the
    // naive `innerHeight - vv.height` delta reads 0 and the composer would hide
    // behind the keyboard. The keyboard height is recovered from
    // `screen.height - vv.height`, gated to the iOS standalone/native surface
    // (SCREEN_KEYBOARD_SIGNAL_ACTIVE, the same gate the reclaim installs on) and
    // above KEYBOARD_INTRUSION_THRESHOLD_PX so the ~59px resting collapse is
    // never misread as a keyboard.
    expect(overlaySrc).toContain("visualViewport");
    expect(overlaySrc).toContain("KEYBOARD_INTRUSION_THRESHOLD_PX");
    expect(overlaySrc).toContain("SCREEN_KEYBOARD_SIGNAL_ACTIVE");
    expect(overlaySrc).toContain("shouldInstallStandaloneBottomReclaim");
  });
});

// ===================================================================
// THE CONSUMPTION CONTRACT (#15178, third blind spot). The chain so far pins:
// module EXISTS (durable-contract block) → installer runs on the REAL boot path
// (real-chain block) → var MEASURES correctly on device (chip rc59). But a
// measured var that NOTHING consumes is still a black strip: shaw's WIP rewrite
// (f903c59) dropped the `bottom: STANDALONE_BOTTOM_RECLAIM_OFFSET` from the
// fixed wallpaper/shader background layers, so the var was written (59px) yet
// zero shipped style referenced it — the box wallpaper laid out inside the
// collapsed 873px ICB and the bottom 59px stayed unpainted (device: rc59 +
// rcw:on but the strip PERSISTS). Every jsdom test above stayed green because
// none asserted a CONSUMER. These source-level assertions pin that the visual
// bottom layers (backgrounds + composer offset) REFERENCE the offset, so a
// future style sweep dropping all consumers turns CI RED instead of silently
// re-shipping the strip. Chain now pinned end-to-end:
// exists → installed on real boot path → measured → CONSUMED by shipped styles.
describe("Bottom-reclaim CONSUMPTION contract — the measured var actually paints the strip", () => {
  const uiSrc = resolve(process.cwd(), "src");

  it("the wallpaper (image) background layer consumes the reclaim offset on its bottom (extends past the collapsed ICB)", () => {
    const src = readFileSync(
      resolve(uiSrc, "backgrounds/ImageBackground.tsx"),
      "utf8",
    );
    expect(
      src,
      "ImageBackground must import STANDALONE_BOTTOM_RECLAIM_OFFSET",
    ).toContain(
      'import { STANDALONE_BOTTOM_RECLAIM_OFFSET } from "../platform/standalone-bottom-reclaim"',
    );
    // The fixed `inset-0` wallpaper must override `bottom` with the measured
    // offset so it reaches the TRUE physical bottom (else the wallpaper stops
    // ~59px short on device and the dead band paints as the recurring strip).
    expect(
      src,
      "ImageBackground's fixed wallpaper must set bottom: STANDALONE_BOTTOM_RECLAIM_OFFSET (consume the measured var)",
    ).toContain("bottom: STANDALONE_BOTTOM_RECLAIM_OFFSET");
  });

  it("the default shader background layer consumes the reclaim offset on its bottom", () => {
    const src = readFileSync(
      resolve(uiSrc, "backgrounds/ShaderBackground.tsx"),
      "utf8",
    );
    expect(
      src,
      "ShaderBackground must import STANDALONE_BOTTOM_RECLAIM_OFFSET",
    ).toContain(
      'import { STANDALONE_BOTTOM_RECLAIM_OFFSET } from "../platform/standalone-bottom-reclaim"',
    );
    expect(
      src,
      "ShaderBackground's fixed ember field must set bottom: STANDALONE_BOTTOM_RECLAIM_OFFSET (the ember pool must reach the true bottom, not stop at the collapsed ICB)",
    ).toContain("bottom: STANDALONE_BOTTOM_RECLAIM_OFFSET");
  });

  it("the programmable (GLSL) shader background layer consumes the reclaim offset on its bottom", () => {
    const src = readFileSync(
      resolve(uiSrc, "backgrounds/ProgrammableShaderBackground.tsx"),
      "utf8",
    );
    expect(
      src,
      "ProgrammableShaderBackground must import STANDALONE_BOTTOM_RECLAIM_OFFSET",
    ).toContain(
      'import { STANDALONE_BOTTOM_RECLAIM_OFFSET } from "../platform/standalone-bottom-reclaim"',
    );
    expect(
      src,
      "ProgrammableShaderBackground's fixed GLSL field must set bottom: STANDALONE_BOTTOM_RECLAIM_OFFSET",
    ).toContain("bottom: STANDALONE_BOTTOM_RECLAIM_OFFSET");
  });

  it("AT LEAST ONE background layer consumes the offset (a total sweep of all consumers goes RED)", () => {
    // Belt-and-suspenders: even if a refactor renames the individual files, the
    // set of background layers must collectively still consume the var. If ALL
    // consumers vanish (shaw's f903c59 regression) this fails loudly.
    const bgFiles = [
      "backgrounds/ImageBackground.tsx",
      "backgrounds/ShaderBackground.tsx",
      "backgrounds/ProgrammableShaderBackground.tsx",
    ];
    const consumers = bgFiles.filter((f) =>
      readFileSync(resolve(uiSrc, f), "utf8").includes(
        "bottom: STANDALONE_BOTTOM_RECLAIM_OFFSET",
      ),
    );
    expect(
      consumers.length,
      "the measured --standalone-bottom-reclaim var must be CONSUMED by the visual bottom layers; zero consumers = the #15178 black strip re-ships silently",
    ).toBeGreaterThan(0);
  });

  it("the composer overlay ALSO consumes the reclaim offset at rest (the full visual bottom set: backgrounds + composer)", () => {
    // Mirror of the real-chain composer assertion, grouped here so the whole
    // CONSUMPTION set (paints + interactive bottom) is pinned in one contract.
    const overlaySrc = readFileSync(
      resolve(uiSrc, "components/shell/ContinuousChatOverlay.tsx"),
      "utf8",
    );
    expect(
      overlaySrc,
      "the resting composer must seat at the reclaim offset (consume the var so the composer + wallpaper agree on the true bottom)",
    ).toContain(": STANDALONE_BOTTOM_RECLAIM_OFFSET");
  });
});
