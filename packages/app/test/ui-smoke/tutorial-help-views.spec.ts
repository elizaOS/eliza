/**
 * Playwright UI-smoke spec for the Tutorial Help Views app flow using the real
 * renderer fixture.
 */
import { expect, test } from "@playwright/test";
import { installDefaultAppRoutes, openAppPath } from "./helpers";

/**
 * Verifies the two new home-pinned views:
 *  - Tutorial + Help tiles are pinned to the home screen (Tutorial first).
 *  - The Tutorial tile opens the launcher, and Start activates the interactive
 *    spotlight overlay (the tour card) that survives navigation.
 *  - The Help view searches the knowledge base and shows matching answers.
 *  - The tour NEVER auto-launches — it only starts from the tile / launcher.
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
  await page.getByTestId("tutorial-start").click();
  const card = page.getByTestId("tutorial-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText(/Meet Eliza/i);

  // It can be dismissed.
  await page.getByTestId("tutorial-skip").click();
  await expect(card).toHaveCount(0);

  // 3. Help → the floating chat is its search box; typing filters + expands the
  // best match (the per-state walkthrough spec covers this in depth).
  await page.getByTestId("home-tile-help").click();
  await expect(page.getByTestId("help-view")).toBeVisible();
  const composer = page.getByTestId("chat-composer-textarea");
  await expect(composer).toHaveAttribute(
    "placeholder",
    /question about eliza/i,
  );
  await composer.fill("change the model");
  const entry = page.getByTestId("help-entry-change-model");
  await expect(entry).toBeVisible();
  await expect(entry).toContainText(/AI Model/i);
});

test("the tour does not auto-launch for a first-time user", async ({
  page,
}) => {
  // A brand-new user with no tutorial flags set: the tour must stay closed and
  // only ever open from an explicit action (the home Tutorial tile / launcher).
  await installDefaultAppRoutes(page);
  await openAppPath(page, "/chat");

  // Wait past the beat the old auto-launch used (1.5s), then assert nothing popped.
  await expect(page.getByTestId("home-tile-tutorial")).toBeVisible({
    timeout: 25_000,
  });
  await page.waitForTimeout(2500);
  await expect(page.getByTestId("tutorial-card")).toHaveCount(0);
});
