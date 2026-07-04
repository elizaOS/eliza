/**
 * Visual regression coverage for the marketing homepage routes.
 *
 * Every route and viewport is compared against committed baselines via
 * toHaveScreenshot, while the quality-retry pre-check rejects blank or
 * half-painted captures with a clear diagnostic before pixel diffing.
 * Baselines regenerate per platform through scripts/regenerate-baselines.sh.
 */

import { expect, type Page, test } from "playwright/test";
import { captureScreenshotWithQualityRetry } from "./screenshot-quality";

const ROUTES = [
  { path: "/", name: "landing" },
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
  // The /leaderboard intro (SVG letter swap → spring-revealed tab bar) is
  // react-spring/JS-driven, so `animations: "disabled"` cannot freeze it and
  // a fixed wait races slow app-JS loads. Wait for the last spring-revealed
  // control ("Try Now") instead, then give the springs time to reach rest.
  if (routePath === "/leaderboard") {
    await page.waitForSelector("header", { timeout: 20_000 }).catch(() => {});
    await page
      .getByText("Try Now")
      .first()
      .waitFor({ timeout: 15_000 })
      .catch(() => {});
    await page.waitForTimeout(2500);
    return;
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
        test.setTimeout(60_000);
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
          },
        );
      });
    }
  });
}
