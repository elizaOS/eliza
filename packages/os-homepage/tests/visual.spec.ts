// Visual regression baselines for os-homepage.
// Run once with --update-snapshots to generate baselines. See tests/VISUAL-REGRESSION.md.

import { expect, type Page, test } from "playwright/test";

const ROUTES = [
  { path: "/", name: "landing" },
  { path: "/hardware/usb", name: "hardware-usb" },
  { path: "/hardware/usb-plastic", name: "hardware-usb-plastic" },
  { path: "/hardware/case", name: "hardware-case" },
  { path: "/hardware/raspberry-pi", name: "hardware-raspberry-pi" },
  { path: "/hardware/mini-pc", name: "hardware-mini-pc" },
  { path: "/hardware/phone", name: "hardware-phone" },
  { path: "/hardware/box", name: "hardware-box" },
  { path: "/hardware/chibi-usb", name: "hardware-chibi-usb" },
  { path: "/checkout", name: "checkout" },
  { path: "/checkout/success", name: "checkout-success" },
  { path: "/checkout/cancel", name: "checkout-cancel" },
] as const;

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 720 },
  { name: "mobile", width: 390, height: 844 },
] as const;

async function prepare(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(async () => {
    const wait = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));
    const step = Math.max(window.innerHeight, 600);
    const height = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
    );

    for (let y = 0; y < height; y += step) {
      window.scrollTo(0, y);
      await wait(50);
    }

    await Promise.all(
      Array.from(document.images).map((image) => {
        if (image.complete) return Promise.resolve();
        return new Promise((resolve) => {
          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", resolve, { once: true });
        });
      }),
    );

    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(250);
}

function dynamicMask(page: Page) {
  return [
    page.locator(".cloud-background img"),
    page.locator("video"),
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
