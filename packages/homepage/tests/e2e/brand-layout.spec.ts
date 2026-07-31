/**
 * Browser-level contracts for stable brand sizing and landing capture readiness.
 */
import { expect, test } from "playwright/test";

test("onboarding wordmark preserves its intrinsic aspect ratio", async ({
  page,
}) => {
  await page.goto("/get-started", { waitUntil: "domcontentloaded" });
  const logo = page.getByRole("img", { name: "Eliza" });
  await expect(logo).toBeVisible();

  const dimensions = await logo.evaluate((element) => {
    const image = element as HTMLImageElement;
    const rect = image.getBoundingClientRect();
    return {
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      width: rect.width,
      height: rect.height,
    };
  });

  expect(dimensions.naturalWidth).toBe(512);
  expect(dimensions.naturalHeight).toBe(216);
  expect(dimensions.width).toBeLessThan(100);
  expect(dimensions.width / dimensions.height).toBeCloseTo(512 / 216, 2);
});

test("landing exposes a settled phone capture boundary", async ({ page }) => {
  test.setTimeout(30_000);
  await page.goto("/leaderboard", { waitUntil: "domcontentloaded" });

  await expect(page.locator("[data-phone-model]")).toHaveAttribute(
    "data-phone-model",
    "settled",
    { timeout: 20_000 },
  );
});
