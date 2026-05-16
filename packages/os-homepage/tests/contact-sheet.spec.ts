import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "playwright/test";

const outDir = join(import.meta.dir, "..", "test-results", "contact-sheet");

const desktopViewport = { width: 1440, height: 900 };
const mobileViewport = { width: 390, height: 844 };

const desktopFrames: Array<{ name: string; selector?: string; full?: boolean }> = [
  { name: "01-hero", selector: ".hero-os" },
  { name: "02-install", selector: "#download" },
  { name: "03-local-first", selector: ".band-orange" },
  { name: "04-downloads", selector: "#downloads" },
  { name: "05-hardware-top", selector: "#hardware" },
  { name: "06-hardware-bottom", selector: "footer" },
];

const mobileFrames: Array<{ name: string; selector?: string }> = [
  { name: "m01-hero", selector: ".hero-os" },
  { name: "m02-install", selector: "#download" },
  { name: "m03-downloads", selector: "#downloads" },
  { name: "m04-hardware-top", selector: "#hardware" },
  { name: "m05-hardware-bottom", selector: "footer" },
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
    await page.waitForSelector(".hero-mark");
    await page.waitForTimeout(400);

    for (const frame of desktopFrames) {
      const locator = page.locator(frame.selector!).first();
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
    await page.waitForSelector(".hero-mark");
    await page.waitForTimeout(400);

    for (const frame of mobileFrames) {
      const locator = page.locator(frame.selector!).first();
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
