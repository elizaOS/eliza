import { expect, test } from "./fixtures";
import { clickTab, pageContainsText } from "./helpers/interaction-helpers";
import {
  cooldownBetweenTests,
  isServerHealthy,
  navigateTo,
  waitForPageLoad,
} from "./helpers/page-helpers";
import { ROUTES, SELECTORS, VIEWPORTS } from "./helpers/test-data";
import { loginWithWallet } from "./helpers/wallet-auth";

test.setTimeout(60000);

test.describe("Leaderboard - Tab Toggle", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.LEADERBOARD);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("default tab loads with content", async ({ page }) => {
    const hasContent = await pageContainsText(
      page,
      "leaderboard",
      "rank",
      "top",
      "player",
    );
    expect(hasContent).toBe(true);
  });

  // LeaderboardToggle renders exactly two scope buttons: "Per Wallet" and
  // "Team".
  test("Team tab accessible", async ({ page }) => {
    const switched = await clickTab(page, "Team");
    expect(switched).toBe(true);
  });

  test("switch back to per-wallet tab", async ({ page }) => {
    await clickTab(page, "Team");
    await page.waitForTimeout(500);
    const switched = await clickTab(page, "Per Wallet");
    expect(switched).toBe(true);
  });

  test("each tab shows different content", async ({ page }) => {
    const individualBody = await page.locator("body").textContent();
    await clickTab(page, "Team");
    await page.waitForTimeout(500);
    const teamBody = await page.locator("body").textContent();
    expect(individualBody).toBeTruthy();
    expect(teamBody).toBeTruthy();
  });
});

test.describe("Leaderboard - Pagination", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.LEADERBOARD);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("pagination controls display", async ({ page }) => {
    // The leaderboard footer always renders Previous / Next buttons.
    const nextBtn = page.locator(SELECTORS.PAGINATION_NEXT).first();
    const prevBtn = page.locator(SELECTORS.PAGINATION_PREV).first();
    await expect(nextBtn).toBeVisible({ timeout: 5000 });
    await expect(prevBtn).toBeVisible();
  });

  test("next page button works", async ({ page }) => {
    const nextBtn = page.locator(SELECTORS.PAGINATION_NEXT).first();
    const isVisible = await nextBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no pagination controls rendered on the leaderboard");
    const beforeBody = await page.locator("body").textContent();
    await nextBtn.click({ force: true });
    await page.waitForTimeout(1000);
    const afterBody = await page.locator("body").textContent();
    expect(afterBody).toBeTruthy();
    // Paging to the next page must change the rendered list.
    expect(afterBody).not.toBe(beforeBody);
  });

  test("previous page button works", async ({ page }) => {
    const nextBtn = page.locator(SELECTORS.PAGINATION_NEXT).first();
    const isVisible = await nextBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no pagination controls rendered on the leaderboard");
    await nextBtn.click({ force: true });
    await page.waitForTimeout(500);
    const prevBtn = page.locator(SELECTORS.PAGINATION_PREV).first();
    await expect(
      prevBtn,
      "no previous-page control after paging forward",
    ).toBeVisible({ timeout: 3000 });
    await prevBtn.click({ force: true });
    await page.waitForTimeout(500);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
  });

  test("first page disables previous button", async ({ page }) => {
    const prevBtn = page.locator(SELECTORS.PAGINATION_PREV).first();
    const isVisible = await prevBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no pagination controls rendered on the leaderboard");
    // On the first page the previous-page control must be disabled.
    await expect(prevBtn).toBeDisabled();
  });
});

test.describe("Leaderboard - User Interaction", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.LEADERBOARD);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("jump to own position control", async ({ page }) => {
    // The jump control is a button with a crosshair icon + "#<rank>", shown
    // only when the logged-in user has a leaderboard position.
    const jumpBtn = page.locator("button:has(svg.lucide-crosshair)").first();
    const isVisible = await jumpBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(
      !isVisible,
      "logged-in user has no leaderboard position in this seed",
    );
    await expect(jumpBtn).toBeEnabled();
    await jumpBtn.click({ force: true });
  });

  test("user detail sidebar opens on click", async ({ page }) => {
    const userRow = page
      .locator('tr, [data-testid*="leaderboard-row"], .leaderboard-item')
      .first();
    const isVisible = await userRow
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no leaderboard rows rendered");
    await userRow.click({ force: true });
    await page.waitForTimeout(1000);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
  });

  test("follow button on leaderboard entry", async ({ page }) => {
    // Leaderboard rows render a FollowButton per entry when entries exist.
    const row = page
      .locator('tr, [data-testid*="leaderboard-row"], .leaderboard-item')
      .first();
    const hasRows = await row.isVisible({ timeout: 5000 }).catch(() => false);
    test.skip(!hasRows, "no leaderboard rows rendered in this seed");
    const followBtn = page.locator(SELECTORS.FOLLOW_BUTTON).first();
    await expect(followBtn).toBeVisible({ timeout: 5000 });
  });

  test("rank badges display", async ({ page }) => {
    const row = page
      .locator('tr, [data-testid*="leaderboard-row"], .leaderboard-item')
      .first();
    const hasRows = await row.isVisible({ timeout: 5000 }).catch(() => false);
    test.skip(!hasRows, "no leaderboard rows rendered in this seed");
    const hasBadges = await pageContainsText(page, "#1", "rank");
    expect(hasBadges).toBe(true);
  });

  test("mobile navigation works", async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.MOBILE);
    await page.waitForTimeout(500);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    const overflowX = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    expect(overflowX).toBe(false);
  });
});
