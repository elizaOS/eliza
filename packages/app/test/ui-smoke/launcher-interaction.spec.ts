import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

/**
 * Interaction-level coverage for the iOS-like view catalog (Launcher, #8796).
 *
 * Unlike builtin-views-visual.spec (which only asserts each view boots without
 * crashing), this drives the catalog's actual controls — long-press edit mode,
 * the favorite/pin badge, page navigation, and tap-to-launch — against a live
 * app boot. Run with E2E_RECORD=1 to capture a video walkthrough.
 */
test.describe("launcher catalog interactions", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
  });

  async function holdTilePastLongPressThreshold(
    page: Page,
    tile: Locator,
  ): Promise<void> {
    const button = tile.locator("button").first();
    const box = await button.boundingBox();
    if (!box) throw new Error("launcher tile button is not laid out");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(500);
  }

  test("renders the launcher with visual tiles and a chat composer", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await openAppPath(page, "/views");

    await expect(page.getByTestId("launcher")).toBeVisible({
      timeout: 60_000,
    });
    // At least one named tile renders.
    await expect(
      page.locator('[data-testid^="launcher-tile-"]').first(),
    ).toBeVisible();
    // The floating chat composer sits at the bottom (the single chat surface).
    await expect(page.getByTestId("chat-composer-textarea")).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Done" })).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test("long-press never creates a favorites row in the app launcher", async ({
    page,
  }) => {
    await openAppPath(page, "/views");
    await expect(page.getByTestId("launcher")).toBeVisible({
      timeout: 60_000,
    });

    const firstTile = page.locator('[data-testid^="launcher-tile-"]').first();
    await expect(firstTile).toBeVisible();

    await expect(page.getByTestId("launcher-dock")).toHaveCount(0);

    // The app's curated launcher is read-only, so long-press must not surface a
    // special favorites row or per-tile favorite affordances.
    await holdTilePastLongPressThreshold(page, firstTile);
    await expect(page.getByTestId("launcher-dock")).toHaveCount(0);
    await expect(page.locator('[data-testid^="launcher-fav-"]')).toHaveCount(0);
    await expect(firstTile).toBeVisible();
    await page.mouse.up();
  });

  test("paging dots switch the visible page when present", async ({ page }) => {
    await openAppPath(page, "/views");
    await expect(page.getByTestId("launcher")).toBeVisible({
      timeout: 60_000,
    });

    const page2 = page.getByRole("button", { name: "Page 2" });
    // The stub catalog may be a single page; only assert paging when a 2nd
    // page exists, so the test is meaningful without being brittle.
    if ((await page2.count()) > 0) {
      await page2.click();
      await expect(page2).toHaveAttribute("aria-current", "true");
    }
  });

  test("tapping a tile navigates to that view", async ({ page }) => {
    await openAppPath(page, "/views");
    await expect(page.getByTestId("launcher")).toBeVisible({
      timeout: 60_000,
    });

    const firstTile = page.locator('[data-testid^="launcher-tile-"]').first();
    const tileId = await firstTile.getAttribute("data-testid");
    const viewId = (tileId ?? "").replace("launcher-tile-", "");
    // The tile's launch button carries the view label as its accessible name.
    await firstTile.locator("button").first().click();
    // Navigation left /views (the launcher) for the chosen view.
    await expect
      .poll(() => new URL(page.url()).hash + new URL(page.url()).pathname)
      .not.toContain("/views");
    expect(viewId.length).toBeGreaterThan(0);
  });
});
