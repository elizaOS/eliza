/**
 * Visual regression coverage for the public homepage routes.
 *
 * Every route and viewport is compared against committed baselines using the
 * exact capture the quality-and-stability gate validated: blank or
 * half-painted frames are rejected, and the gate requires two consecutive
 * visually-stable captures so a mid-composite WebGL frame is never diffed.
 * Baselines regenerate per platform through scripts/regenerate-baselines.sh.
 */

import { expect, type Page, test } from "playwright/test";
import { waitForLandingIntro } from "./landing-readiness";
import { captureScreenshotWithQualityRetry } from "./screenshot-quality";
import { VISUAL_ROUTES, VISUAL_VIEWPORTS } from "./visual-routes";

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

async function prepareProfileAuth(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("eliza_app_session", "homepage-visual-token");
  });
  await page.route("https://elizacloud.ai/api/eliza-app/**", (route) =>
    route.fulfill({
      json: {
        user: {
          id: "user_homepage_visual",
          name: "Homepage Visual",
          organization_id: "org_homepage_visual",
        },
        organization: {
          id: "org_homepage_visual",
          name: "Homepage Visual Org",
          credit_balance: "0",
        },
      },
    }),
  );
}

async function prepare(page: Page, routePath?: string) {
  if (routePath === "/" || routePath === "/leaderboard") {
    await waitForLandingIntro(page);
    return;
  }
  await page.evaluate(() => document.fonts.ready);
  if (
    routePath === "/login" ||
    routePath === "/connected" ||
    routePath === "/profile/edit"
  ) {
    await page.waitForFunction(
      () =>
        window.location.pathname === "/get-started" ||
        document.body.textContent?.includes("Connected.") ||
        document.body.textContent?.includes("Link a public wallet."),
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

for (const viewport of VISUAL_VIEWPORTS) {
  test.describe(`visual regression — ${viewport.name}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      reducedMotion: "reduce",
      timezoneId: "UTC",
    });

    for (const route of VISUAL_ROUTES) {
      test(`${route.name} (${viewport.name})`, async ({ page }) => {
        test.setTimeout(60_000);
        await page.clock.setFixedTime(FIXED_TIME);
        if ("authed" in route && route.authed) await prepareProfileAuth(page);
        const target = "goto" in route ? route.goto : route.path;
        await page.goto(target, { waitUntil: "domcontentloaded" });
        await prepare(page, route.path);
        const screenshot = await captureScreenshotWithQualityRetry(
          page,
          `${route.name} ${viewport.name}`,
          {
            fullPage: true,
            mask: dynamicMask(page),
            animations: "disabled",
          },
        );
        expect(screenshot).toMatchSnapshot(
          `${route.name}-${viewport.name}.png`,
          { maxDiffPixelRatio: 0.02 },
        );
      });
    }
  });
}
