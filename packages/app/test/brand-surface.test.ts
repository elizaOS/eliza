/**
 * Brand-surface smoke. Verifies the first-paint surfaces (FOUC HTML, native
 * launch configs, capacitor + Android/iOS resources) agree on the Eliza
 * orange palette so the user never sees a foreign color before the React
 * tree mounts. The actual home / pre-agent screen lives in `@elizaos/ui`'s
 * <App /> (packages/ui/src/App.tsx) and `@elizaos/app-core` window
 * orchestration; this test asserts the shell-owned surfaces this package
 * actually controls.
 *
 * Two distinct oranges (#9565): boot/launch/loading/splash surfaces use the
 * HOME-BACKGROUND orange (#ef5a1f, DEFAULT_BACKGROUND_COLOR) so they do not
 * flash a different orange before the home background paints; the brand/logo
 * accent (theme accent, App Actions widget, launcher icon) stays #FF5800.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const here = import.meta.dirname;
const root = join(here, "..");
const appCorePlatformsRoot = join(root, "..", "app-core", "platforms");

const BRAND_ORANGE = "#FF5800";
// DEFAULT_BACKGROUND_COLOR from @elizaos/ui (packages/ui/src/state/ui-preferences.ts):
// the color the home ShaderBackground + StartupShell loader paint. Boot/launch
// surfaces track this so boot never flashes the brand accent first (#9565).
const HOME_BACKGROUND_ORANGE = "#ef5a1f";

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

function readGeneratedOrTemplate(rel: string): string {
  const generatedPath = join(root, rel);
  if (existsSync(generatedPath)) return readFileSync(generatedPath, "utf8");

  const [platform, ...segments] = rel.split("/");
  return readFileSync(
    join(appCorePlatformsRoot, platform, ...segments),
    "utf8",
  );
}

describe("brand surfaces", () => {
  it("app.config web/theme colors are the home-background orange (launch surface)", () => {
    const src = read("app.config.ts");
    // theme_color / background_color feed the PWA manifest + <meta theme-color>
    // + native launch surfaces — all boot/first-paint, so they track the home
    // background, not the brand accent (#9565).
    expect(src).toMatch(/themeColor:\s*"#ef5a1f"/);
    expect(src).toMatch(/backgroundColor:\s*"#ef5a1f"/);
    expect(BRAND_ORANGE).toBe("#FF5800");
    expect(HOME_BACKGROUND_ORANGE).toBe("#ef5a1f");
  });

  it("capacitor config native backgrounds are the home-background orange (launch surface)", () => {
    const src = read("capacitor.config.ts");
    expect(src).toMatch(/SplashScreen:\s*\{[^}]*backgroundColor:\s*"#ef5a1f"/s);
    expect(src).toMatch(/ios:\s*\{[^}]*backgroundColor:\s*"#ef5a1f"/s);
    expect(src).toMatch(/android:\s*\{[^}]*backgroundColor:\s*"#ef5a1f"/s);
  });

  it("Android colors.xml + styles.xml: launch surfaces home-orange, accents brand-orange", () => {
    const colors = readGeneratedOrTemplate(
      "android/app/src/main/res/values/colors.xml",
    );
    // Launch splash + launch status bar track the home background.
    expect(colors).toContain(
      '<color name="splash_background">#ef5a1f</color>',
    );
    // Brand accent (App Actions widget) + theme accent stay brand orange.
    expect(colors).toContain('<color name="eliza_orange">#FF5800</color>');
    expect(colors).toContain('<color name="colorPrimary">#FF5800</color>');

    const styles = readGeneratedOrTemplate(
      "android/app/src/main/res/values/styles.xml",
    );
    // The launch status bar points at the launch-splash (home) color so it does
    // not flash the brand accent before the home background paints (#9565).
    expect(styles).toMatch(/statusBarColor[^<]*@color\/splash_background/);
  });

  it("iOS LaunchScreen.storyboard backdrop is the home-background orange (launch surface)", () => {
    const xml = readGeneratedOrTemplate(
      "ios/App/App/Base.lproj/LaunchScreen.storyboard",
    );
    // 0.937 / 0.353 / 0.122 is #ef5a1f in sRGB to 3 decimals — the home
    // background, so iOS does not flash the brand accent on launch (#9565).
    expect(xml).toMatch(/red="0\.937"\s+green="0\.353"\s+blue="0\.122"/);
  });

  it("index.html FOUC fallback is the home background orange, not a foreign color", () => {
    const html = read("index.html");
    // The FOUC fallback tracks the home background orange (#ef5a1f, #9565) so
    // boot does not flash a different orange before the home background paints;
    // pure black or the legacy brand orange remain acceptable. The previous
    // `#08080a` near-black is a slop value and should not regress.
    expect(html).not.toContain("#08080a");
    expect(html).toMatch(
      /background-color:\s*var\(--bg,\s*(#000000|#FF5800|#ef5a1f)\)/,
    );
  });

  it("no rounded-lg/xl/2xl/3xl chunky rounding in app shell source", () => {
    // The shell only owns src/. Decorative roundness belongs in ui/, where
    // it is reviewed separately. This guards the shell from drifting.
    const offenders: string[] = [];
    const files = [
      "src/main.tsx",
      "src/model-tester-entry.tsx",
      "src/deep-link-handler.ts",
      "src/deep-link-routing.ts",
      "src/mobile-lifecycle.ts",
      "src/mobile-bridges.ts",
      "src/plugin-registrations.ts",
      "src/character-catalog.ts",
      "src/sw-registration.ts",
      "src/ios-runtime.ts",
      "src/url-trust-policy.ts",
    ];
    for (const file of files) {
      const src = read(file);
      if (/rounded-(lg|xl|2xl|3xl)\b/.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("no glass-blur / sky / cyan slop in app shell source", () => {
    const offenders: string[] = [];
    const files = [
      "src/main.tsx",
      "src/deep-link-handler.ts",
      "src/deep-link-routing.ts",
      "src/mobile-lifecycle.ts",
      "src/mobile-bridges.ts",
      "src/plugin-registrations.ts",
      "src/character-catalog.ts",
      "src/sw-registration.ts",
      "src/ios-runtime.ts",
      "src/url-trust-policy.ts",
    ];
    for (const file of files) {
      const src = read(file);
      if (/sky-\d|cyan-\d|backdrop-blur|glassmorphism/.test(src)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("desktop OS pill uses the transparent chat-overlay shell", () => {
    const mainSrc = read("src/main.tsx");
    const stylesSrc = read("../ui/src/styles/styles.css");
    const pillSrc = read("../app-core/platforms/electrobun/src/pill-window.ts");

    expect(pillSrc).toContain('url.search = "?shellMode=chat-overlay"');
    expect(mainSrc).toContain("isChatOverlayWindowShell");
    expect(mainSrc).toContain(
      'root.classList.toggle("eliza-chat-overlay-shell", chatOverlayShell)',
    );
    expect(stylesSrc).toContain("html.eliza-chat-overlay-shell #root");
    expect(stylesSrc).toContain("background: transparent");
  });
});
