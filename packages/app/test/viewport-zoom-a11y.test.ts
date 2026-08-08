/**
 * WCAG 2.2 SC 1.4.4 regression guard for the web viewport meta tag.
 *
 * Two layers of coverage:
 * 1. Source-level — the shared index.html uses a build-time token
 *    (`__APP_VIEWPORT_CONTENT__`) and the vite.config.ts replacement constants
 *    produce WCAG-compliant output for web and native builds.
 * 2. Build-output — invokes the REAL `appShellMetadataPlugin` exported from
 *    vite.config.ts and feeds the actual source index.html through its
 *    `transformIndexHtml` hook. This proves the plugin's replacement map and
 *    hook registration work end-to-end — a misconfigured map, dropped token,
 *    or unregistered hook would cause the test to fail.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appShellMetadataPlugin,
  VIEWPORT_META_NATIVE,
  VIEWPORT_META_WEB,
} from "../vite.config";

const appRoot = path.resolve(import.meta.dirname, "..");

function readAppFile(rel: string): string {
  return readFileSync(path.join(appRoot, rel), "utf8");
}

/**
 * Invoke the real appShellMetadataPlugin's transformIndexHtml hook on the
 * given source HTML, simulating a non-Capacitor (web) build environment.
 *
 * The plugin reads `process.env.ELIZA_CAPACITOR_BUILD_TARGET` at module load
 * time to determine IS_CAPACITOR_MOBILE_BUILD. Since vite.config.ts is already
 * loaded (defaulting to a web build), the plugin resolves to the web viewport
 * constants. The returned string is the actual output the Vite build pipeline
 * would emit.
 */
function transformHtmlViaPlugin(sourceHtml: string): string {
  const plugin = appShellMetadataPlugin();
  // transformIndexHtml is a synchronous hook on this plugin (no async context
  // needed), so we can call it directly. If Vite ever wraps it in an object
  // form ({ handler, order }) we handle that too.
  const hook = plugin.transformIndexHtml;
  if (typeof hook === "function") {
    return (hook as (html: string) => string | string[])(sourceHtml) as string;
  }
  if (
    typeof hook === "object" &&
    hook !== null &&
    "handler" in hook &&
    typeof hook.handler === "function"
  ) {
    return (hook.handler as (html: string) => string | string[])(
      sourceHtml,
    ) as string;
  }
  throw new Error(
    "appShellMetadataPlugin.transformIndexHtml is neither a function nor an object handler",
  );
}

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

describe("viewport zoom a11y — build-output (real plugin transform)", () => {
  it("real appShellMetadataPlugin resolves the token to the WCAG-compliant web viewport", () => {
    const sourceHtml = readAppFile("index.html");

    // Run the source through the REAL plugin's transformIndexHtml hook.
    // Since vite.config.ts loads with ELIZA_CAPACITOR_BUILD_TARGET unset,
    // IS_CAPACITOR_MOBILE_BUILD is false → web viewport constants apply.
    const emittedHtml = transformHtmlViaPlugin(sourceHtml);

    // The token MUST be gone — replaced by the real plugin.
    expect(emittedHtml).not.toContain("__APP_VIEWPORT_CONTENT__");

    // The resolved viewport meta must match the exported VIEWPORT_META_WEB
    // constant exactly — not a duplicated literal.
    expect(emittedHtml).toContain(
      `<meta name="viewport" content="${VIEWPORT_META_WEB}" />`,
    );

    // The WCAG-failing directives must NOT be present in the emitted HTML.
    expect(emittedHtml).not.toMatch(/user-scalable\s*=\s*no/);
    expect(emittedHtml).not.toMatch(/maximum-scale\s*=\s*1\.0/);
  });

  it("real appShellMetadataPlugin resolves ALL metadata tokens, not just viewport", () => {
    const sourceHtml = readAppFile("index.html");
    const emittedHtml = transformHtmlViaPlugin(sourceHtml);

    // No raw tokens should survive the transform — they all must resolve.
    expect(emittedHtml).not.toContain("__APP_");
  });

  it("unresolved HTML still contains the raw token (regression guard)", () => {
    const sourceHtml = readAppFile("index.html");

    // If the transform stopped firing, the token would remain in the output.
    // This proves the build-output assertions above have teeth: the raw
    // index.html source still carries the token before the hook runs.
    expect(sourceHtml).toContain("__APP_VIEWPORT_CONTENT__");

    // And the source must NOT already contain the resolved viewport values
    // (otherwise the transform would be a no-op and the tests above would
    // pass even if the hook were removed).
    expect(sourceHtml).not.toContain(
      `<meta name="viewport" content="${VIEWPORT_META_WEB}"`,
    );
    expect(sourceHtml).not.toMatch(
      /<meta name="viewport" content="width=device-width, initial-scale=1\.0, maximum-scale=1\.0/,
    );
  });

  it("the exported VIEWPORT_META_NATIVE constant retains the lockdown for Capacitor builds", () => {
    // Verify the exported constant itself carries the lockdown directives.
    // This is what the Vite build substitutes when
    // ELIZA_CAPACITOR_BUILD_TARGET is ios or android.
    expect(VIEWPORT_META_NATIVE).toMatch(/user-scalable\s*=\s*no/i);
    expect(VIEWPORT_META_NATIVE).toMatch(/maximum-scale\s*=\s*1\.0/i);
    expect(VIEWPORT_META_NATIVE).toMatch(/viewport-fit\s*=\s*cover/i);
  });

  it("a misconfigured plugin (token removed from index.html) would fail the transform test", () => {
    // This is a mutation-test proof: if the token were absent from the source,
    // the emitted HTML would not contain the resolved viewport meta.
    const tamperedHtml = readAppFile("index.html").replaceAll(
      "__APP_VIEWPORT_CONTENT__",
      "INTENTIONALLY_BROKEN",
    );
    const emittedHtml = transformHtmlViaPlugin(tamperedHtml);

    // The plugin has no replacement for INTENTIONALLY_BROKEN, so the
    // WCAG-compliant viewport is NOT present — proving the test has teeth.
    expect(emittedHtml).not.toContain(
      `<meta name="viewport" content="${VIEWPORT_META_WEB}"`,
    );
    expect(emittedHtml).toContain("INTENTIONALLY_BROKEN");
  });
});
