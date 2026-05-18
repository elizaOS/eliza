// Visual regression baselines for os-usb-installer.
// Run once with --update-snapshots to generate baselines. See tests/VISUAL-REGRESSION.md.
//
// NOTE: This package does not yet have Playwright wired up — see VISUAL-REGRESSION.md
// for the setup steps required before this spec can run.

import { expect, type Page, test } from "@playwright/test";

const ROUTES = [{ path: "/", name: "landing" }] as const;

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 720 },
  { name: "mobile", width: 390, height: 844 },
] as const;

async function prepare(page: Page) {
  await page.evaluate(() => document.fonts.ready);
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
