/** Playwright coverage for the intentionally non-destructive Backups surface. */

import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

test("Backups offers backup and restore without an in-app destructive reset", async ({
  page,
}) => {
  await openAppPath(page, "/settings");
  await openSettingsSection(page, "Backups");

  await expect(
    page.getByRole("button", { name: /Back up agent/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Restore agent/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reset Everything" }),
  ).toHaveCount(0);
});
