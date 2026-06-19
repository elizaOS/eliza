// Render smoke checks for the marketing homepage.

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
  // The /leaderboard route runs a ~1800ms intro animation before the real UI
  // (header, tab bar, BlobButton) settles. Match the contact-sheet timing.
  if (routePath === "/leaderboard") {
    await page.waitForSelector("header", { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(3000);
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
        await expect(page.locator("body")).toBeVisible();
      });
    }
  });
}
