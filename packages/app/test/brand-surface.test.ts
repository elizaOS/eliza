/**
 * Brand-surface smoke. Verifies the first-paint / launch surfaces (FOUC HTML,
 * native launch configs, capacitor + Android/iOS resources) use the right
 * color for their lifetime, so the user never sees a foreign color — or a
 * glowing orange band — behind or after the home background paints.
 *
 * Three colors, kept deliberately separate (issues #9565, orange-band fix):
 *  - LAUNCH_DARK (#160d07) — every PERSISTENT host-chrome surface: the
 *    index.html FOUC background (html/body/#root stays the page background
 *    under the app forever — it bleeds through the iOS home-indicator
 *    safe-area and overscroll zones), the PWA <meta theme-color> and manifest
 *    colors (iOS standalone paints the home-indicator inset with it). This
 *    equals DEFAULT_BACKGROUND_COLOR (packages/ui/src/state/ui-preferences.ts),
 *    the ember-night base of the default home wallpaper, so any bleed-through
 *    is invisible against the app.
 *  - SPLASH_ORANGE (#ef5a1f) — native boot splash surfaces ONLY (capacitor
 *    splash, Android splash resources, iOS LaunchScreen). These are true
 *    boot-flash surfaces that are fully covered once the app paints, so they
 *    keep the legacy launch orange; they must never be a persistent surface.
 *  - BRAND_ORANGE (#FF5800) — the brand accent (logos, brand surfaces). It may
 *    persist on brand resources but must NOT be a launch surface.
 *
 * The actual home / pre-agent screen lives in `@elizaos/ui`'s <App />
 * (packages/ui/src/App.tsx) and `@elizaos/app-core` window orchestration; this
 * test asserts the shell-owned surfaces this package actually controls.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const here = import.meta.dirname;
const root = join(here, "..");
const appCorePlatformsRoot = join(root, "..", "app-core", "platforms");

const BRAND_ORANGE = "#FF5800";
const LAUNCH_DARK = "#160d07";
const SPLASH_ORANGE = "#ef5a1f";
const SPLASH_ORANGE_RGB = [239, 90, 31];
const ANDROID_SPLASH_TEMPLATE_FILES = [
  "android/app/src/main/res/drawable/splash.png",
  "android/app/src/main/res/drawable-land-hdpi/splash.png",
  "android/app/src/main/res/drawable-land-mdpi/splash.png",
  "android/app/src/main/res/drawable-land-xhdpi/splash.png",
  "android/app/src/main/res/drawable-land-xxhdpi/splash.png",
  "android/app/src/main/res/drawable-land-xxxhdpi/splash.png",
  "android/app/src/main/res/drawable-port-hdpi/splash.png",
  "android/app/src/main/res/drawable-port-mdpi/splash.png",
  "android/app/src/main/res/drawable-port-xhdpi/splash.png",
  "android/app/src/main/res/drawable-port-xxhdpi/splash.png",
  "android/app/src/main/res/drawable-port-xxxhdpi/splash.png",
];

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

function platformTemplatePath(rel: string): string {
  const [platform, ...segments] = rel.split("/");
  return join(appCorePlatformsRoot, platform, ...segments);
}

async function readPngRgb(path: string, x = 0, y = 0): Promise<number[]> {
  const { data } = await sharp(path)
    .ensureAlpha()
    .extract({ left: x, top: y, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return Array.from(data.subarray(0, 3));
}

describe("brand surfaces", () => {
  it("launch dark equals the default home background color", () => {
    // The single source of truth for the home background base. Every
    // persistent host-chrome surface below must equal this so any strip the
    // app's fixed background layers don't cover (iOS home-indicator inset,
    // overscroll) is invisible. If the default home background changes, this
    // test forces the host-chrome surfaces to move with it.
    const uiPrefs = readFileSync(
      join(root, "..", "ui", "src", "state", "ui-preferences.ts"),
      "utf8",
    );
    expect(uiPrefs).toMatch(
      new RegExp(`DEFAULT_BACKGROUND_COLOR\\s*=\\s*"${LAUNCH_DARK}"`),
    );
  });

  it("app.config web/theme colors are the persistent dark surface (not orange)", () => {
    // theme-color paints the iOS-standalone home-indicator safe-area inset —
    // a PERSISTENT surface, so it must be the dark app background, never the
    // splash orange (which read as a glowing band under the composer) and
    // never the brand accent.
    const src = read("app.config.ts");
    expect(src).toMatch(new RegExp(`themeColor:\\s*"${LAUNCH_DARK}"`));
    expect(src).toMatch(new RegExp(`backgroundColor:\\s*"${LAUNCH_DARK}"`));
    expect(src).not.toMatch(new RegExp(`themeColor:\\s*"${SPLASH_ORANGE}"`));
    expect(src).not.toMatch(/themeColor:\s*"#FF5800"/);
  });

  it("capacitor config and native backgrounds are the splash orange", () => {
    const src = read("capacitor.config.ts");
    expect(src).toMatch(
      new RegExp(
        `SplashScreen:\\s*\\{[^}]*backgroundColor:\\s*"${SPLASH_ORANGE}"`,
        "s",
      ),
    );
    expect(src).toMatch(
      new RegExp(`ios:\\s*\\{[^}]*backgroundColor:\\s*"${SPLASH_ORANGE}"`, "s"),
    );
    expect(src).toMatch(
      new RegExp(
        `android:\\s*\\{[^}]*backgroundColor:\\s*"${SPLASH_ORANGE}"`,
        "s",
      ),
    );
  });

  it("Android colors.xml + styles.xml: launch surfaces home-orange, accents brand-orange", async () => {
    const colors = readGeneratedOrTemplate(
      "android/app/src/main/res/values/colors.xml",
    );
    // Launch splash + launch status bar track the home background; brand
    // accent tokens stay separate and unchanged.
    expect(colors).toContain(
      `<color name="splash_background">${SPLASH_ORANGE}</color>`,
    );
    expect(colors).toContain(
      `<color name="eliza_orange">${BRAND_ORANGE}</color>`,
    );
    expect(colors).toContain(
      `<color name="colorPrimary">${BRAND_ORANGE}</color>`,
    );

    const styles = readGeneratedOrTemplate(
      "android/app/src/main/res/values/styles.xml",
    );
    // The launch status bar follows the splash/home, not the brand accent.
    expect(styles).toMatch(/statusBarColor[^<]*@color\/splash_background/);
    expect(styles).not.toMatch(/statusBarColor[^<]*@color\/eliza_orange/);

    for (const rel of ANDROID_SPLASH_TEMPLATE_FILES) {
      expect(await readPngRgb(platformTemplatePath(rel)), rel).toEqual(
        SPLASH_ORANGE_RGB,
      );
    }
  });

  it("iOS LaunchScreen.storyboard is a solid home-background-orange launch view", () => {
    const xml = readGeneratedOrTemplate(
      "ios/App/App/Base.lproj/LaunchScreen.storyboard",
    );
    // 0.937 / 0.353 / 0.122 is #ef5a1f in sRGB to 3 decimals.
    expect(xml).toMatch(/red="0\.937"\s+green="0\.353"\s+blue="0\.122"/);
    expect(xml).not.toMatch(/red="1\.0"\s+green="0\.345"\s+blue="0\.0"/);
    expect(xml).not.toContain("<imageView");
    expect(xml).not.toContain('image name="Splash"');
  });

  it("index.html FOUC fallback uses the persistent launch dark, not orange", () => {
    const html = read("index.html");
    // html/body/#root is a PERSISTENT page background, not a boot-flash-only
    // surface: it bleeds through wherever the app's fixed background layers
    // don't reach (iOS home-indicator safe-area, overscroll). It must track
    // the dark home background (#160d07 = DEFAULT_BACKGROUND_COLOR) so any
    // bleed is invisible; the old launch orange read as a glowing band.
    // The `#08080a` near-black slop value must also not regress.
    expect(html).not.toContain("#08080a");
    expect(html).toMatch(new RegExp(`--launch-bg:\\s*${LAUNCH_DARK}`));
    expect(html).toMatch(
      new RegExp(
        `html,\\s*body,\\s*#root\\s*\\{[^}]*background-color:\\s*var\\(--launch-bg,\\s*${LAUNCH_DARK}\\)`,
        "s",
      ),
    );
    // The splash orange must never be a persistent html/body/#root surface.
    expect(html).not.toMatch(
      new RegExp(`var\\(--launch-bg,\\s*${SPLASH_ORANGE}\\)`),
    );
    expect(html).not.toMatch(/background-color:\s*var\(--bg/);
    // The pre-#9565 brand-accent fallback must not regress.
    expect(html).not.toMatch(/var\(--bg,\s*#FF5800\)/);
  });

  it("renderer root CSS keeps the pre-app surface on the launch dark", () => {
    // Same persistence argument as index.html: html/body/#root in the
    // renderer CSS is the page background under the app, so its --launch-bg
    // fallback must be the dark app surface, never the splash orange.
    const styles = read("../ui/src/styles/styles.css");
    expect(styles).toMatch(
      new RegExp(
        `body\\s*\\{[^}]*background:\\s*var\\(--launch-bg,\\s*${LAUNCH_DARK}\\)`,
        "s",
      ),
    );
    expect(styles).toMatch(
      new RegExp(
        `#root\\s*\\{[^}]*background:\\s*var\\(--launch-bg,\\s*${LAUNCH_DARK}\\)`,
        "s",
      ),
    );
    expect(styles).not.toMatch(
      new RegExp(`var\\(--launch-bg,\\s*${SPLASH_ORANGE}\\)`),
    );
    expect(styles).not.toMatch(/#root\s*\{[^}]*background:\s*var\(--bg\)/s);
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

  it("desktop chat overlay uses the transparent in-app shell", () => {
    const mainSrc = read("src/main.tsx");
    const appSrc = read("../ui/src/App.tsx");
    const stylesSrc = read("../ui/src/styles/styles.css");

    expect(
      existsSync(
        join(root, "../app-core/platforms/electrobun/src/pill-window.ts"),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(
          root,
          "../app-core/platforms/electrobun/src/desktop-pill-config.ts",
        ),
      ),
    ).toBe(false);
    expect(mainSrc).toContain("isChatOverlayWindowShell");
    expect(mainSrc).toContain(
      'root.classList.toggle("eliza-chat-overlay-shell", chatOverlayShell)',
    );
    expect(appSrc).toContain('data-testid="chat-overlay-shell"');
    expect(appSrc).toContain("<ContinuousChatOverlay");
    expect(stylesSrc).toContain("html.eliza-chat-overlay-shell #root");
    expect(stylesSrc).toContain("background: transparent");
  });
});
