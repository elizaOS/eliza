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

const FIXED_TIME = new Date("2026-01-15T14:30:00.000Z");

test.skip(
  process.platform !== "linux",
  "Visual regression baselines are committed for the Linux CI renderer only",
);

async function waitForShader(page: Page) {
  await expect(page.locator("[data-shader-background]")).toHaveAttribute(
    "data-shader-background",
    "settled",
    { timeout: 20_000 },
  );
}

async function waitForOnboardingCards(page: Page) {
  const lastCard = page.getByTestId("solana-signin");
  await lastCard.waitFor({ state: "visible", timeout: 20_000 });
  await expect
    .poll(
      () =>
        lastCard.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            opacity: Number(style.opacity),
            transform: style.transform,
          };
        }),
      { timeout: 20_000 },
    )
    .toEqual({ opacity: 1, transform: "matrix(1, 0, 0, 1, 0, 0)" });
}

async function prepare(page: Page, routePath?: string) {
  if (routePath === "/" || routePath === "/leaderboard") {
    await waitForLandingIntro(page);
    return;
  }
  await page.evaluate(() => document.fonts.ready);
  if (routePath === "/login" || routePath === "/connected") {
    await page.waitForFunction(
      () =>
        window.location.pathname === "/get-started" ||
        document.body.textContent?.includes("Connected."),
      undefined,
      { timeout: 20_000 },
    );
  }
  if (
    routePath === "/get-started" ||
    routePath === "/login" ||
    routePath === "/connected"
  ) {
    await waitForShader(page);
    await waitForOnboardingCards(page);
  }
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
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      reducedMotion: "reduce",
      timezoneId: "UTC",
    });

    for (const route of ROUTES) {
      test(`${route.name} (${viewport.name})`, async ({ page }) => {
        test.setTimeout(60_000);
        await page.clock.setFixedTime(FIXED_TIME);
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
            maxDiffPixelRatio: 0.02,
          },
        );
      });
    }
  });
}
