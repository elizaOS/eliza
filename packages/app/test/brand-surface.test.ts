/**
 * Brand-surface smoke. Verifies the first-paint / launch surfaces (FOUC HTML,
 * native launch configs, capacitor + Android/iOS resources) use the right
 * color for their lifetime, so the user never sees a foreign color — or a
 * glowing orange band — behind or after the home background paints.
 *
 * Three colors, kept deliberately separate (issue #9565):
 *  - LAUNCH_BLACK (#000000) — every PERSISTENT host-chrome surface: the
 *    index.html FOUC background (html/body/#root stays the page background
 *    under the app forever — it bleeds through the iOS home-indicator
 *    safe-area and overscroll zones), the PWA <meta theme-color> and manifest
 *    colors (iOS standalone paints the home-indicator inset with it). This
 *    MUST equal DEFAULT_BACKGROUND_COLOR (packages/ui/src/state/
 *    ui-preferences.ts) — the brand-orange field of the default home
 *    ShaderBackground — so any bleed-through is invisible against the app.
 *  - SPLASH_BLACK (#000000) — native boot splash surfaces (capacitor splash,
 *    Android splash resources, iOS LaunchScreen). Currently the same hex as
 *    LAUNCH_BLACK, but kept a separate constant: splash tracks the boot
 *    flash, launch tracks the home background, and they may diverge again.
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
const LAUNCH_BLACK = "#000000";
const SPLASH_BLACK = "#000000";
const SPLASH_BLACK_RGB = [0, 0, 0];
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
  it("launch black equals the default home background base color", () => {
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
      new RegExp(`DEFAULT_BACKGROUND_COLOR\\s*=\\s*"${LAUNCH_BLACK}"`),
    );
  });

  it("app.config web/theme colors track the home background (never the brand accent)", () => {
    // theme-color paints the iOS-standalone home-indicator safe-area inset —
    // a PERSISTENT surface, so it must equal the default home background,
    // never the brand accent.
    const src = read("app.config.ts");
    expect(src).toMatch(new RegExp(`themeColor:\\s*"${LAUNCH_BLACK}"`));
    expect(src).toMatch(new RegExp(`backgroundColor:\\s*"${LAUNCH_BLACK}"`));
    expect(src).not.toMatch(/themeColor:\s*"#FF5800"/);
  });

  it("capacitor config and native backgrounds are the splash black", () => {
    const src = read("capacitor.config.ts");
    expect(src).toMatch(
      new RegExp(
        `SplashScreen:\\s*\\{[^}]*backgroundColor:\\s*"${SPLASH_BLACK}"`,
        "s",
      ),
    );
    expect(src).toMatch(
      new RegExp(`ios:\\s*\\{[^}]*backgroundColor:\\s*"${SPLASH_BLACK}"`, "s"),
    );
    expect(src).toMatch(
      new RegExp(
        `android:\\s*\\{[^}]*backgroundColor:\\s*"${SPLASH_BLACK}"`,
        "s",
      ),
    );
  });

  it("Android colors.xml + styles.xml: launch surfaces black, accents brand-orange", async () => {
    const colors = readGeneratedOrTemplate(
      "android/app/src/main/res/values/colors.xml",
    );
    // Launch splash + launch status bar track the home background; brand
    // accent tokens stay separate and unchanged.
    expect(colors).toContain(
      `<color name="splash_background">${SPLASH_BLACK}</color>`,
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
        SPLASH_BLACK_RGB,
      );
    }
  });

  it("iOS LaunchScreen.storyboard is a solid black launch view", () => {
    const xml = readGeneratedOrTemplate(
      "ios/App/App/Base.lproj/LaunchScreen.storyboard",
    );
    // 0.0 / 0.0 / 0.0 is #000000 in sRGB.
    expect(xml).toMatch(/red="0\.0"\s+green="0\.0"\s+blue="0\.0"/);
    expect(xml).not.toMatch(/red="1\.0"\s+green="0\.345"\s+blue="0\.0"/);
    expect(xml).not.toContain("<imageView");
    expect(xml).not.toContain('image name="Splash"');
  });

  it("index.html FOUC fallback uses the launch black (the home background base)", () => {
    const html = read("index.html");
    // html/body/#root is a PERSISTENT page background, not a boot-flash-only
    // surface: it bleeds through wherever the app's fixed background layers
    // don't reach (iOS home-indicator safe-area, overscroll). It must track
    // the home background base (#000000 = DEFAULT_BACKGROUND_COLOR) so any bleed
    // is invisible. The `#08080a` near-black slop value must not regress.
    expect(html).not.toContain("#08080a");
    expect(html).toMatch(new RegExp(`--launch-bg:\\s*${LAUNCH_BLACK}`));
    expect(html).toMatch(
      new RegExp(
        `html,\\s*body,\\s*#root\\s*\\{[^}]*background-color:\\s*var\\(--launch-bg,\\s*${LAUNCH_BLACK}\\)`,
        "s",
      ),
    );
    expect(html).not.toMatch(/background-color:\s*var\(--bg/);
    // The pre-#9565 brand-accent fallback must not regress.
    expect(html).not.toMatch(/var\(--bg,\s*#FF5800\)/);
  });

  it("keeps the branded preboot status visible until React takes over", () => {
    const html = read("index.html");
    expect(html).toContain('class="eliza-preboot-shell__mark"');
    expect(html).toContain('class="eliza-preboot-shell__status"');
    expect(html).toContain("Booting up&hellip;");
  });

  it("preboot logo uses a base-aware brand path so it resolves on deep web routes and native builds", () => {
    // BASE_URL resolves from the origin in web builds and beside the document
    // in packaged builds, preserving both deep SPA routes and bundled assets.
    const html = read("index.html");
    expect(html).toMatch(
      /class="eliza-preboot-shell__mark"\s+src="%BASE_URL%brand\/logos\/logo_white_nobg\.svg"/,
    );
    expect(html).not.toMatch(
      /class="eliza-preboot-shell__mark"\s+src="\.\/brand/,
    );
  });

  it("renderer root CSS keeps the pre-app surface on the launch black", () => {
    // Same persistence argument as index.html: html/body/#root in the
    // renderer CSS is the page background under the app, so its --launch-bg
    // fallback must equal the default home background.
    const styles = read("../ui/src/styles/styles.css");
    expect(styles).toMatch(
      new RegExp(
        `body\\s*\\{[^}]*background:\\s*var\\(--launch-bg,\\s*${LAUNCH_BLACK}\\)`,
        "s",
      ),
    );
    expect(styles).toMatch(
      new RegExp(
        `#root\\s*\\{[^}]*background:\\s*var\\(--launch-bg,\\s*${LAUNCH_BLACK}\\)`,
        "s",
      ),
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
