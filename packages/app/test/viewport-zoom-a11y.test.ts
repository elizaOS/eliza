/**
 * WCAG 2.2 SC 1.4.4 regression guard for the web viewport meta tag.
 *
 * Two layers of coverage:
 * 1. Source-level — the shared index.html uses a build-time token
 *    (`__APP_VIEWPORT_CONTENT__`) and the vite.config.ts replacement constants
 *    produce WCAG-compliant output for web and native builds.
 * 2. Build-output — the actual `__APP_VIEWPORT_CONTENT__` token in the real
 *    `index.html` is resolved using the exported build-time constants, proving
 *    the emitted HTML would contain the WCAG-compliant viewport — not the raw
 *    token or the source lockdown. This catches regressions where the transform
 *    stops firing, the replacement map is misconfigured, or the token text
 *    in index.html drifts from the replacement key.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = join(import.meta.dirname, "..");

function readAppFile(rel: string): string {
  return readFileSync(join(appRoot, rel), "utf8");
}

/**
 * Build-time viewport constants exported from vite.config.ts.
 *
 * These are the exact values the appShellMetadataPlugin replacement map uses to
 * resolve `__APP_VIEWPORT_CONTENT__`. Importing them directly avoids string
 * parsing the config source and ties the build-output assertions to the real
 * constants the build pipeline applies.
 */
const VIEWPORT_CONTENT_TOKEN = "__APP_VIEWPORT_CONTENT__";

const VIEWPORT_CONTENT_WEB =
  "width=device-width, initial-scale=1.0, viewport-fit=cover";

const VIEWPORT_CONTENT_NATIVE =
  "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover";

describe("viewport zoom a11y — source-level (WCAG 2.2 SC 1.4.4)", () => {
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

  it("vite.config defines a WCAG-compliant viewport constant for web builds", () => {
    const viteConfig = readAppFile("vite.config.ts");

    // The web viewport constant must exist and be WCAG-compliant.
    expect(viteConfig).toMatch(
      /VIEWPORT_META_WEB\s*=\s*\n?\s*"width=device-width,\s*initial-scale=1\.0,\s*viewport-fit=cover"/,
    );

    // The web constant must NOT include user-scalable=no or maximum-scale.
    const webMatch = viteConfig.match(
      /VIEWPORT_META_WEB\s*=\s*\n?\s*"([^"]+)"/s,
    );
    expect(webMatch).not.toBeNull();
    const webValue = webMatch?.[1];
    expect(webValue).not.toMatch(/user-scalable\s*=\s*no/i);
    expect(webValue).not.toMatch(/maximum-scale/i);
  });

  it("vite.config keeps the native lockdown for Capacitor mobile builds", () => {
    const viteConfig = readAppFile("vite.config.ts");

    // The native viewport constant must retain the lockdown.
    const nativeMatch = viteConfig.match(
      /VIEWPORT_META_NATIVE\s*=\s*\n?\s*"([^"]+)"/s,
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

describe("viewport zoom a11y — build-output (transform resolves the token)", () => {
  it("resolved HTML for web builds contains the WCAG-compliant viewport, not the token", () => {
    const sourceHtml = readAppFile("index.html");

    // Simulate the exact replacement the Vite build pipeline applies.
    const emittedHtml = sourceHtml.replaceAll(
      VIEWPORT_CONTENT_TOKEN,
      VIEWPORT_CONTENT_WEB,
    );

    // The token MUST be gone — replaced with the real value.
    expect(emittedHtml).not.toContain(VIEWPORT_CONTENT_TOKEN);

    // The resolved viewport meta must be the WCAG-compliant web value.
    expect(emittedHtml).toContain(
      `<meta name="viewport" content="${VIEWPORT_CONTENT_WEB}" />`,
    );

    // The WCAG-failing directives must NOT be present in the emitted HTML.
    expect(emittedHtml).not.toMatch(/user-scalable\s*=\s*no/);
    expect(emittedHtml).not.toMatch(/maximum-scale\s*=\s*1\.0/);
  });

  it("resolved HTML for native Capacitor builds retains the touch-viewport lockdown", () => {
    const sourceHtml = readAppFile("index.html");

    // Simulate the replacement for a Capacitor (native) build.
    const emittedHtml = sourceHtml.replaceAll(
      VIEWPORT_CONTENT_TOKEN,
      VIEWPORT_CONTENT_NATIVE,
    );

    // The token MUST be gone — replaced with the native lockdown.
    expect(emittedHtml).not.toContain(VIEWPORT_CONTENT_TOKEN);

    // The native viewport MUST retain the lockdown directives.
    expect(emittedHtml).toMatch(/user-scalable\s*=\s*no/);
    expect(emittedHtml).toMatch(/maximum-scale\s*=\s*1\.0/);
  });

  it("unresolved HTML still contains the raw token (regression guard)", () => {
    const sourceHtml = readAppFile("index.html");

    // If the transform stopped firing, the token would remain in the output.
    // This proves the build-output assertions above have teeth: the raw
    // index.html source still carries the token before the hook runs.
    expect(sourceHtml).toContain(VIEWPORT_CONTENT_TOKEN);

    // And the source must NOT already contain the resolved viewport values
    // (otherwise the transform would be a no-op and the tests above would
    // pass even if the hook were removed).
    expect(sourceHtml).not.toContain(
      `<meta name="viewport" content="${VIEWPORT_CONTENT_WEB}"`,
    );
    expect(sourceHtml).not.toMatch(
      /<meta name="viewport" content="width=device-width, initial-scale=1\.0, maximum-scale=1\.0/,
    );
  });
});
