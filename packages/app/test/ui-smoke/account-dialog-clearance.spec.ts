/**
 * Exercises account enrollment dialogs in the real app renderer with the
 * canonical API fixtures. Ordinary pointer cancellation must remain reachable
 * above persistent chat chrome on mobile as well as desktop.
 */
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { seedStewardSession } from "./helpers/test-auth";

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`account dialogs remain cancellable at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await seedAppStorage(page);
    await seedStewardSession(page, { jwt: true });
    await installDefaultAppRoutes(page);
    await openAppPath(page, "/settings");
    if (viewport.width < 640) {
      await page.getByRole("button", { name: "Models & Providers" }).click();
    }

    for (const provider of ["OpenRouter", "xAI API"]) {
      await page
        .getByRole("button", { name: "Add account", exact: true })
        .click();
      await page.getByPlaceholder("Search providers").fill(provider);
      await page.getByRole("option").filter({ hasText: provider }).click();
      await expect(page.locator("#add-account-apikey")).toBeVisible();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
  });
}
