/**
 * Records a walkthrough of the settings surface for PR evidence: this PR
 * changes locale catalogs and splits one settings key, so the artifact a
 * reviewer needs is the surface actually rendering with those catalogs. Video
 * is enabled per-context here rather than globally so the rest of the smoke
 * suite keeps its current cost.
 */
import { expect, test } from "@playwright/test";

test.use({ video: { mode: "on", size: { width: 1440, height: 900 } } });

test("settings surface walkthrough (PR evidence)", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(4000);

  await page.goto("/settings");
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(3000);
  await expect(
    page.getByText("Settings", { exact: false }).first(),
  ).toBeVisible({
    timeout: 30_000,
  });
  await page.waitForTimeout(1200);

  // Scroll the surface so the capture shows the rendered rows rather than a
  // single static frame. Clicking section entries is deliberately omitted: the
  // shell's overlay intercepts pointer events in this harness, and the artifact
  // this PR owes is the surface RENDERING with the restored catalogs, not a
  // navigation flow — nothing in this diff changes navigation.
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(1500);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(2000);
});
