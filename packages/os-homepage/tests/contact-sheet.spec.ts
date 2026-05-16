import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "playwright/test";

const outDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "test-results",
  "contact-sheet",
);

const desktopViewport = { width: 1440, height: 900 };
const mobileViewport = { width: 390, height: 844 };

const desktopFrames: Array<{ name: string; selector: string }> = [
  { name: "01-hero", selector: ".hero-cloud" },
  { name: "02-install", selector: "#download" },
  { name: "03-local-first", selector: ".band-orange" },
  { name: "04-hardware-top", selector: "#hardware" },
  { name: "05-hardware-bottom", selector: "footer" },
];

const mobileFrames: Array<{ name: string; selector: string }> = [
  { name: "m01-hero", selector: ".hero-cloud" },
  { name: "m02-install", selector: "#download" },
  { name: "m03-hardware-top", selector: "#hardware" },
  { name: "m04-hardware-bottom", selector: "footer" },
];

test.describe("contact sheet", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  test.beforeAll(async () => {
    await mkdir(outDir, { recursive: true });
  });

  test("desktop @1440x900", async ({ page }) => {
    await page.setViewportSize(desktopViewport);
    await page.goto("/");
    await page.waitForSelector(".hero-cloud");
    await page.waitForTimeout(400);

    for (const frame of desktopFrames) {
      const locator = page.locator(frame.selector).first();
      await locator.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await page.screenshot({
        path: join(outDir, `desktop-${frame.name}.png`),
        fullPage: false,
        type: "png",
      });
    }
  });

  test("mobile @390x844", async ({ page }) => {
    await page.setViewportSize(mobileViewport);
    await page.goto("/");
    await page.waitForSelector(".hero-cloud");
    await page.waitForTimeout(400);

    for (const frame of mobileFrames) {
      const locator = page.locator(frame.selector).first();
      await locator.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await page.screenshot({
        path: join(outDir, `mobile-${frame.name}.png`),
        fullPage: false,
        type: "png",
      });
    }
  });
});
