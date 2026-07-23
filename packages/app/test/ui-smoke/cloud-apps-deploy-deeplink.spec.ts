/**
 * Browser-level compatibility proof for the retired Cloud Applications route.
 * The alias must converge on Projects without mounting the former studio.
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

test("/cloud-apps redirects to the Projects surface", async ({ page }) => {
  await openAppPath(page, "/cloud-apps");

  await expect(page).toHaveURL(/\/apps\/tasks$/);
  await expect(page.getByTestId("tasks-view")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
});
