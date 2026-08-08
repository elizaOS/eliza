/**
 * Browser-level WCAG 2.2 SC 1.4.4 zoom test for the web viewport meta tag.
 *
 * This spec runs under the `mobile-chromium` Playwright project (Pixel 7,
 * hasTouch). On Desktop Chrome, `Emulation.setPageScaleFactor` overrides
 * the viewport meta unconditionally — the scale change happens even with
 * `maximum-scale=1.0, user-scalable=no`. Under a genuine mobile/touch
 * profile the locked meta correctly blocks the scale, so only the mobile
 * project distinguishes the WCAG-compliant viewport from the lockdown.
 *
 * The spec serves the resolved index.html (the same
 * `__APP_VIEWPORT_CONTENT__` → `VIEWPORT_META_WEB` replacement the Vite
 * build applies) and uses Chromium's CDP `Emulation.setPageScaleFactor` to
 * simulate a 2× pinch-zoom, then asserts `visualViewport.scale` reaches
 * 2.0.
 *
 * A negative-control test asserts the OLD lockdown
 * (`maximum-scale=1.0, user-scalable=no`) would BLOCK the zoom under the
 * same mobile profile — proving the test has teeth.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.join(__dirname, "..");

const VIEWPORT_CONTENT_WEB =
  "width=device-width, initial-scale=1.0, viewport-fit=cover";
const VIEWPORT_CONTENT_LOCKED =
  "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover";

/**
 * Read the actual index.html source and apply the exact token replacement the
 * Vite build pipeline applies for web builds.
 */
function resolvedWebIndexHtml(): string {
  const source = readFileSync(path.join(appRoot, "index.html"), "utf8");
  return source.replaceAll("__APP_VIEWPORT_CONTENT__", VIEWPORT_CONTENT_WEB);
}

/**
 * Read the actual index.html source but apply the OLD lockdown meta — the
 * negative control proving the spec catches a regression.
 */
function lockdownIndexHtml(): string {
  const source = readFileSync(path.join(appRoot, "index.html"), "utf8");
  return source.replaceAll("__APP_VIEWPORT_CONTENT__", VIEWPORT_CONTENT_LOCKED);
}

test.describe("WCAG 2.2 SC 1.4.4 — browser-level zoom (visualViewport.scale)", () => {
  test("resolved web viewport allows 2× zoom via visualViewport.scale", async ({
    page,
  }) => {
    // Serve the resolved HTML inline so the browser loads it with the real
    // WCAG-compliant viewport meta.
    const html = resolvedWebIndexHtml();
    await page.route("**/", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: html }),
    );
    await page.goto("https://localhost/", { waitUntil: "domcontentloaded" });

    // Baseline: scale should be 1.0 at 100% zoom.
    const baselineScale = await page.evaluate(
      () => window.visualViewport?.scale ?? 1,
    );
    expect(baselineScale).toBeCloseTo(1, 1);

    // Simulate a 2× pinch-zoom via CDP (the browser equivalent of the
    // real gesture the issue asks us to test).
    const client = await page.context().newCDPSession(page);
    await client.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });

    // Wait for visualViewport to update.
    await page.waitForTimeout(500);

    // The WCAG-compliant viewport meta (no user-scalable=no, no
    // maximum-scale) must allow the scale change under the mobile profile.
    const zoomedScale = await page.evaluate(
      () => window.visualViewport?.scale ?? 1,
    );
    expect(zoomedScale).toBeGreaterThan(1.5);
  });

  test("resolved web viewport meta contains no WCAG-failing directives", async ({
    page,
  }) => {
    const html = resolvedWebIndexHtml();
    await page.route("**/", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: html }),
    );
    await page.goto("https://localhost/", { waitUntil: "domcontentloaded" });

    // Verify the loaded document's viewport meta matches the WCAG-compliant value.
    const viewportMeta = await page.evaluate(() => {
      const meta = document.querySelector('meta[name="viewport"]');
      return meta?.getAttribute("content") ?? "";
    });

    expect(viewportMeta).toContain("width=device-width");
    expect(viewportMeta).toContain("initial-scale=1.0");
    expect(viewportMeta).toContain("viewport-fit=cover");
    expect(viewportMeta).not.toMatch(/user-scalable\s*=\s*no/i);
    expect(viewportMeta).not.toMatch(/maximum-scale/i);
  });

  test("old lockdown meta BLOCKS zoom under mobile profile (negative control)", async ({
    page,
  }) => {
    // Serve the lockdown HTML — this is what a regression would look like
    // if someone re-introduced maximum-scale=1.0, user-scalable=no.
    const html = lockdownIndexHtml();
    await page.route("**/", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: html }),
    );
    await page.goto("https://localhost/", { waitUntil: "domcontentloaded" });

    // Baseline: scale should be 1.0 at 100% zoom.
    const baselineScale = await page.evaluate(
      () => window.visualViewport?.scale ?? 1,
    );
    expect(baselineScale).toBeCloseTo(1, 1);

    // Attempt the same 2× pinch-zoom via CDP.
    const client = await page.context().newCDPSession(page);
    await client.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });

    // Wait for visualViewport to update.
    await page.waitForTimeout(500);

    // Under the mobile/touch profile, the locked meta MUST block the scale
    // change — visualViewport.scale stays at 1.0 (or very close).
    // This proves the positive test above is not a false positive: if
    // someone re-introduces the lockdown, this assertion would fail (or
    // the positive test would fail), catching the regression.
    const zoomedScale = await page.evaluate(
      () => window.visualViewport?.scale ?? 1,
    );
    expect(zoomedScale).toBeCloseTo(1, 1);
  });
});
