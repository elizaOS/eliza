// Visual regression baselines for cloud-frontend.
// Run once with --update-snapshots to generate baselines. See tests/VISUAL-REGRESSION.md.

import { expect, type Page, test } from "@playwright/test";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "Visual baselines are captured against local dev only; skipped in live-prod mode",
);

const ROUTES = [
  { path: "/", name: "landing" },
  { path: "/login", name: "login" },
  { path: "/checkout", name: "checkout" },
  { path: "/os", name: "os" },
  { path: "/bsc", name: "bsc" },
  { path: "/privacy-policy", name: "privacy-policy" },
  { path: "/terms-of-service", name: "terms-of-service" },
] as const;

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 720 },
  { name: "mobile", width: 390, height: 844 },
] as const;

test.beforeEach(async ({ context }) => {
  // Stubbed auth cookie so authenticated routes render without backend.
  await context.addCookies([
    {
      name: "eliza-test-auth",
      value: "1",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);
});

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
