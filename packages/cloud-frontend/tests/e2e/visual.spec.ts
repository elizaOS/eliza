// Visual regression baselines for cloud-frontend.
// Run once with --update-snapshots to generate baselines. See tests/VISUAL-REGRESSION.md.
//
// All routes in this spec are PUBLIC (no auth required). Do NOT install the
// eliza-test-auth cookie here — doing so globally causes the landing page (/)
// to detect an authenticated session and redirect to /dashboard/agents, which
// means the baseline snapshot is never captured.

import { expect, type Page, test } from "@playwright/test";
import { captureScreenshotWithQualityRetry } from "./_helpers/screenshot-quality";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "Visual baselines are captured against local dev only; skipped in live-prod mode",
);

const ROUTES = [
  { path: "/", name: "landing" },
  { path: "/login", name: "login" },
  { path: "/os", name: "os" },
  { path: "/bsc", name: "bsc" },
  { path: "/privacy-policy", name: "privacy-policy" },
  { path: "/terms-of-service", name: "terms-of-service" },
] as const;

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 720 },
  { name: "mobile", width: 390, height: 844 },
] as const;

async function prepare(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  // Settle any pending animations one frame before snapshotting.
  await page.waitForTimeout(250);
}

function dynamicMask(page: Page) {
  return [
    page.locator("video"),
    page.locator('[data-testid="cloud-video"]'),
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
        await page.goto(route.path, { waitUntil: "networkidle" });
        await prepare(page);
        await captureScreenshotWithQualityRetry(
          page,
          `${route.name} ${viewport.name}`,
          {
            fullPage: true,
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
