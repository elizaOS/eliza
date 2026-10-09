/**
 * Playwright UI-smoke spec for the Apps Session app flow using the real
 * renderer fixture.
 */
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await installDefaultAppRoutes(page);
  await seedAppStorage(page);
});

test("apps view preserves its selected tab and create action after a reload", async ({
  page,
}) => {
  await openAppPath(page, "/apps");
  const apps = page.getByTestId("projects-apps-segment");
  await expect(apps).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Apps", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("button", { name: "Create new app" }),
  ).toBeVisible();

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(apps).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create new app" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/apps(?:[?#]|$)/);
});
