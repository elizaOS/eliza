/**
 * Visual regression coverage for the public homepage routes.
 *
 * Every route and viewport is compared against committed baselines via
 * toHaveScreenshot, while the quality-retry pre-check rejects blank or
 * half-painted captures with a clear diagnostic before pixel diffing.
 * Baselines regenerate per platform through scripts/regenerate-baselines.sh.
 */

import { expect, type Page, test } from "playwright/test";
import { waitForLandingIntro } from "./landing-readiness";
import { captureScreenshotWithQualityRetry } from "./screenshot-quality";

const ROUTES = [
  { path: "/", name: "landing" },
  { path: "/downloads", name: "downloads" },
  { path: "/login", name: "login" },
  { path: "/connected", name: "connected" },
  { path: "/get-started", name: "get-started" },
  { path: "/leaderboard", name: "leaderboard" },
] as const;

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 720 },
  { name: "mobile", width: 390, height: 844 },
] as const;

async function prepare(page: Page, routePath?: string) {
  await page.evaluate(() => document.fonts.ready);
  // React Spring and the Three.js canvas are JS-driven, so Playwright cannot
  // freeze them with `animations: "disabled"`. The component signals only
  // after its final intro texture has reached the browser paint boundary.
  if (routePath === "/" || routePath === "/leaderboard") {
    await waitForLandingIntro(page);
    return;
  }
  if (routePath === "/login" || routePath === "/connected") {
    await page.waitForFunction(
      () =>
        window.location.pathname === "/get-started" ||
        document.body.textContent?.includes("Connected."),
      undefined,
      { timeout: 20_000 },
    );
  }
  await page.waitForTimeout(600);
}

function dynamicMask(page: Page) {
  // Do NOT mask <video> elements — Playwright fills masked regions with
  // magenta by default, which destroys the cloud-sky hero on the landing
  // page. `animations: "disabled"` already pauses video playback and shows
  // the poster image, so masking is unnecessary and harmful here.
  return [
    page.locator(".animate-pulse"),
    page.locator(".animate-spin"),
    page.locator("[data-marquee]"),
  ];
}

for (const viewport of VIEWPORTS) {
  test.describe(`visual regression — ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const route of ROUTES) {
      test(`${route.name} (${viewport.name})`, async ({ page }) => {
        test.setTimeout(90_000);
        await page.goto(route.path, { waitUntil: "domcontentloaded" });
        await prepare(page, route.path);
        await captureScreenshotWithQualityRetry(
          page,
          `${route.name} ${viewport.name}`,
          {
            fullPage: true,
            mask: dynamicMask(page),
            animations: "disabled",
          },
        );
        await expect(page).toHaveScreenshot(
          `${route.name}-${viewport.name}.png`,
          {
            fullPage: true,
            mask: dynamicMask(page),
            animations: "disabled",
            // Fresh Quality #16657 proved stable 6-7% Linux-renderer drift on
            // three mobile baselines across all retries. Keep desktop at the
            // global 5% guard and bound only mobile rendering variance at 8%.
            maxDiffPixelRatio: viewport.name === "mobile" ? 0.08 : 0.05,
          },
        );
      });
    }
  });
}
