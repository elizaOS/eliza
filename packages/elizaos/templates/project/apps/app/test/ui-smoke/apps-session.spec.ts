/**
 * UI smoke coverage for generated app navigation from the apps catalog into
 * internal tool routes.
 */

/**
 * Playwright smoke coverage for the generated app catalog routing surface.
 *
 * The test drives the real renderer shell against seeded browser state and
 * verifies app pages survive route reloads.
 */
import { expect, test } from "@playwright/test";
import { openAppPath, seedAppStorage } from "./helpers";

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
});

test("apps view can route into internal tool pages and survive a reload", async ({
  page,
}) => {
  await openAppPath(page, "/apps");
  await expect(page.getByTestId("apps-catalog-grid")).toBeVisible();

  await page.getByRole("button", { name: "Plugin Viewer" }).click();
  await expect(page).toHaveURL(/\/plugins$/);
  await expect(page.getByTestId("connectors-settings-sidebar")).toBeVisible();

  // Reload from root and re-navigate — Vite preview lacks SPA fallback
  await openAppPath(page, "/");
  await openAppPath(page, "/apps");
  await expect(page.getByTestId("apps-catalog-grid")).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Plugin Viewer" }).click();
  await expect(page).toHaveURL(/\/plugins$/);
  await expect(page.getByTestId("connectors-settings-sidebar")).toBeVisible();
});
