/**
 * WCAG 2.2 SC 1.4.4 regression guard for the web viewport meta tag.
 *
 * The shared index.html uses a build-time token (`__APP_VIEWPORT_CONTENT__`)
 * that the appShellMetadataPlugin replaces with a platform-specific value.
 * Web/desktop builds must not disable user zoom; only native Capacitor builds
 * retain the touch-viewport lockdown. This test asserts the source token is
 * present (not a hardcoded lockdown) and that the build-time replacement logic
 * in vite.config.ts produces WCAG-compliant output for non-native targets.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = join(import.meta.dirname, "..");

function readAppFile(rel: string): string {
  return readFileSync(join(appRoot, rel), "utf8");
}

describe("viewport zoom a11y (WCAG 2.2 SC 1.4.4)", () => {
  it("index.html does not hardcode the zoom lockdown", () => {
    const html = readAppFile("index.html");
    // The viewport meta must use the build-time token, not a literal lock.
    expect(html).toContain(
      '<meta name="viewport" content="__APP_VIEWPORT_CONTENT__" />',
    );
    // The WCAG-failing directives must not appear in the source.
    expect(html).not.toMatch(/user-scalable\s*=\s*no/);
    expect(html).not.toMatch(/maximum-scale\s*=\s*1\.0/);
  });

  it("vite.config resolves the token to a WCAG-compliant viewport for web builds", () => {
    const viteConfig = readAppFile("vite.config.ts");

    // The web viewport must not contain user-scalable=no or a maximum-scale cap.
    expect(viteConfig).toMatch(
      /VIEWPORT_CONTENT_WEB\s*=\s*\n?\s*"width=device-width,\s*initial-scale=1\.0,\s*viewport-fit=cover"/,
    );

    // The web constant must NOT include user-scalable=no or maximum-scale.
    const webMatch = viteConfig.match(/VIEWPORT_CONTENT_WEB\s*=\s*"([^"]+)"/s);
    expect(webMatch).not.toBeNull();
    const webValue = webMatch?.[1];
    expect(webValue).not.toMatch(/user-scalable\s*=\s*no/i);
    expect(webValue).not.toMatch(/maximum-scale/i);
  });

  it("vite.config keeps the native lockdown for Capacitor mobile builds", () => {
    const viteConfig = readAppFile("vite.config.ts");

    // The native viewport must retain the lockdown.
    const nativeMatch = viteConfig.match(
      /VIEWPORT_CONTENT_NATIVE\s*=\s*\n?\s*"([^"]+)"/s,
    );
    expect(nativeMatch).not.toBeNull();
    const nativeValue = nativeMatch?.[1];
    expect(nativeValue).toMatch(/user-scalable\s*=\s*no/i);
    expect(nativeValue).toMatch(/maximum-scale\s*=\s*1\.0/i);
    expect(nativeValue).toMatch(/viewport-fit\s*=\s*cover/i);
  });

  it("the token replacement is gated on IS_CAPACITOR_MOBILE_BUILD", () => {
    const viteConfig = readAppFile("vite.config.ts");
    // The replacement map must branch on the Capacitor build flag.
    expect(viteConfig).toMatch(
      /__APP_VIEWPORT_CONTENT__[\s\S]*IS_CAPACITOR_MOBILE_BUILD/,
    );
  });
});
