import { expect, test } from "@playwright/test";
import { installDefaultAppRoutes, openAppPath } from "./helpers";

/**
 * Verifies the two new home-pinned views:
 *  - Tutorial + Help tiles are pinned to the home screen (Tutorial first).
 *  - The Tutorial tile opens the launcher, and Start activates the interactive
 *    spotlight overlay (the tour card) that survives navigation.
 *  - The Help view searches the knowledge base and shows matching answers.
 */

test("Tutorial + Help are pinned to home and both work", async ({ page }) => {
  await installDefaultAppRoutes(page);
  await openAppPath(page, "/chat"); // the home screen (tiles)

  // 1. Both tiles are pinned to the home screen.
  const tutorialTile = page.getByTestId("home-tile-tutorial");
  const helpTile = page.getByTestId("home-tile-help");
  await expect(tutorialTile).toBeVisible({ timeout: 25_000 });
  await expect(helpTile).toBeVisible();

  // Tutorial is the FIRST tile.
  const tileIds = await page
    .locator('[data-testid^="home-tile-"]')
    .evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-testid")?.replace("home-tile-", "")),
    );
  expect(tileIds[0]).toBe("tutorial");
  expect(tileIds).toContain("help");

  // 2. Tutorial → launcher → Start → the interactive spotlight overlay appears.
  await tutorialTile.click();
  await expect(page.getByTestId("tutorial-launcher")).toBeVisible();
  await page.getByTestId("tutorial-start-text").click();
  const card = page.getByTestId("tutorial-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText(/Step 1 of/i);

  // It survives navigation and can be dismissed.
  await page.getByText("Skip tutorial").click();
  await expect(card).toHaveCount(0);

  // 3. Help → search the knowledge base → a matching answer with a deep-link.
  await page.getByTestId("home-tile-help").click();
  await expect(page.getByTestId("help-view")).toBeVisible();
  await page.getByTestId("help-search").fill("change the model");
  const entry = page.getByTestId("help-entry-change-model");
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(entry).toContainText(/AI Model/i);
});
