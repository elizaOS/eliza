/** Records the real Settings section navigation and rendered content. */
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";

test.use({ video: { mode: "on", size: { width: 1440, height: 900 } } });

test("settings surface walkthrough (PR evidence)", async ({ page }) => {
  // Background and App Permissions are advanced sections.
  await seedAppStorage(page, { "eliza:developerMode": "1" });
  await installDefaultAppRoutes(page);
  await openAppPath(page, "/settings");
  const shell = page.getByTestId("settings-shell");
  await expect(shell).toBeVisible();
  for (const [id, label] of [
    ["identity", /^Basics\b/],
    ["background", /^Background\b/],
    ["app-permissions", /^App Permissions\b/],
  ] as const) {
    await test.step(id, async () => {
      await openSettingsSection(page, label);
      await expect(shell.locator(`[id="${id}"]`)).toBeVisible();
      await expect(page.getByTestId("settings-section-error")).toHaveCount(0);
    });
  }
});
