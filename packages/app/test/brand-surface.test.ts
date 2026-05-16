/**
 * Brand-surface smoke. Verifies the first-paint surfaces (FOUC HTML, native
 * splash configs, capacitor + Android/iOS resources) agree on the Eliza
 * orange palette so the user never sees a foreign color before the React
 * tree mounts. The actual home / pre-agent screen lives in `@elizaos/ui`'s
 * <App /> (packages/ui/src/App.tsx) and `@elizaos/app-core` window
 * orchestration; this test asserts the shell-owned surfaces this package
 * actually controls.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const here = import.meta.dirname;
const root = join(here, "..");
const appCorePlatformsRoot = join(root, "..", "app-core", "platforms");

const BRAND_ORANGE = "#FF5800";

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
  it("app.config web/theme colors are brand orange", () => {
    const src = read("app.config.ts");
    expect(src).toMatch(/themeColor:\s*"#FF5800"/);
    expect(src).toMatch(/backgroundColor:\s*"#FF5800"/);
    expect(BRAND_ORANGE).toBe("#FF5800");
  });

  it("capacitor config splash, ios and android backgrounds are brand orange", () => {
    const src = read("capacitor.config.ts");
    expect(src).toMatch(/SplashScreen:\s*\{[^}]*backgroundColor:\s*"#FF5800"/s);
    expect(src).toMatch(/ios:\s*\{[^}]*backgroundColor:\s*"#FF5800"/s);
    expect(src).toMatch(/android:\s*\{[^}]*backgroundColor:\s*"#FF5800"/s);
  });

  it("Android colors.xml + styles.xml use brand orange for splash + status bar", () => {
    const colors = readGeneratedOrTemplate(
      "android/app/src/main/res/values/colors.xml",
    );
    expect(colors).toContain('<color name="eliza_orange">#FF5800</color>');
    expect(colors).toContain('<color name="splash_background">#FF5800</color>');
    expect(colors).toContain('<color name="colorPrimary">#FF5800</color>');

    const styles = readGeneratedOrTemplate(
      "android/app/src/main/res/values/styles.xml",
    );
    expect(styles).toContain("@color/eliza_orange");
    expect(styles).toMatch(/statusBarColor[^<]*@color\/eliza_orange/);
  });

  it("iOS LaunchScreen.storyboard backdrop is brand orange", () => {
    const xml = readGeneratedOrTemplate(
      "ios/App/App/Base.lproj/LaunchScreen.storyboard",
    );
    // 1.0 / 0.345 / 0.0 is #FF5800 in sRGB to 3 decimals.
    expect(xml).toMatch(/red="1\.0"\s+green="0\.345"\s+blue="0\.0"/);
  });

  it("index.html FOUC fallback is unified with the dark chat shell, not a foreign color", () => {
    const html = read("index.html");
    // Either pure black or the brand orange is acceptable. The previous
    // `#08080a` near-black is a slop value and should not regress.
    expect(html).not.toContain("#08080a");
    expect(html).toMatch(
      /background-color:\s*var\(--bg,\s*(#000000|#FF5800)\)/,
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
      "src/plugin-loader.ts",
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
      "src/plugin-loader.ts",
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
});
