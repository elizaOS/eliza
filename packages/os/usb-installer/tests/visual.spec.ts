import { expect, type Page, test } from "@playwright/test";
import { mockInstallerApi } from "./mock-installer-api";

const ROUTES = [{ path: "/", name: "landing" }] as const;
const ENABLE_VISUAL_SNAPSHOTS =
  process.env.ELIZAOS_USB_VISUAL_SNAPSHOTS === "1";

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
        await mockInstallerApi(page);
        await page.goto(route.path, { waitUntil: "networkidle" });
        await prepare(page);
        await expect(
          page.getByRole("heading", { name: "USB installer" }),
        ).toBeVisible();
        await expect(page.getByText("elizaOS Test USB")).toBeVisible();

        if (ENABLE_VISUAL_SNAPSHOTS) {
          await expect(page).toHaveScreenshot(
            `${route.name}-${viewport.name}.png`,
            {
              fullPage: true,
              mask: dynamicMask(page),
              animations: "disabled",
            },
          );
        }
      });
    }
  });
}
