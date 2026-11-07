import { expect, test } from "@playwright/test";
import { mockInstallerApi } from "./mock-installer-api";

const ENABLE_VISUAL_SNAPSHOTS =
  process.env.ELIZAOS_USB_VISUAL_SNAPSHOTS === "1";

test("installer renders its assets within the viewport", async ({
  page,
}, testInfo) => {
  await mockInstallerApi(page);
  await page.goto("/", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await expect(
    page.getByRole("heading", { name: "USB installer" }),
  ).toBeVisible();
  await expect(page.getByText("elizaOS Test USB")).toBeVisible();
  await expect(
    page.getByRole("img", { name: "elizaOS", exact: true }),
  ).toHaveCount(2);
  await expect
    .poll(() =>
      page
        .getByRole("img", { name: "elizaOS", exact: true })
        .evaluateAll((images) =>
          images.every(
            (image) =>
              image instanceof HTMLImageElement &&
              image.complete &&
              image.naturalWidth > 0,
          ),
        ),
    )
    .toBe(true);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  const options = { fullPage: true, animations: "disabled" as const };
  const filename = `landing-${testInfo.project.name}.png`;
  await page.screenshot({ ...options, path: testInfo.outputPath(filename) });
  if (ENABLE_VISUAL_SNAPSHOTS)
    await expect(page).toHaveScreenshot(filename, options);
});
