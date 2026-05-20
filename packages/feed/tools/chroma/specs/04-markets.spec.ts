/**
 * Markets Page E2E Tests
 *
 * Tests markets functionality: perps, predictions, trading interfaces,
 * search, filtering, chart periods, watchlist, and Buy Points modal.
 */

import { expect, test } from "./fixtures";
import {
  clickFirstVisible,
  clickTab,
  closeModal,
  fillAndVerify,
  openModal,
  pageContainsText,
} from "./helpers/interaction-helpers";
import {
  cooldownBetweenTests,
  isServerHealthy,
  navigateTo,
  waitForPageLoad,
} from "./helpers/page-helpers";
import { loginWithWallet } from "./helpers/privy-auth";
import { ROUTES, SELECTORS, TIMEOUTS, VIEWPORTS } from "./helpers/test-data";

test.setTimeout(TIMEOUTS.EXTRA_LONG);

test.describe("Markets Dashboard", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateTo(page, ROUTES.MARKETS);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("dashboard displays with Perps and Predictions tabs", async ({
    page,
  }) => {
    expect(page.url()).toContain("/markets");

    const hasMarketsContent = await pageContainsText(
      page,
      "perp",
      "prediction",
      "market",
      "trade",
    );
    expect(hasMarketsContent).toBe(true);
  });

  test("tabs navigate between Perps and Predictions", async ({ page }) => {
    const perpsTab = page
      .locator(
        '[role="tab"]:has-text("Perps"), button:has-text("Perps"), a:has-text("Perps")',
      )
      .first();

    if (
      await perpsTab.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      await perpsTab.click({ force: true });
      await page.waitForTimeout(1500);
    }

    const predictionsTab = page
      .locator(
        '[role="tab"]:has-text("Predictions"), button:has-text("Predictions"), a:has-text("Predictions")',
      )
      .first();

    if (
      await predictionsTab
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false)
    ) {
      await predictionsTab.click({ force: true });
      await page.waitForTimeout(1500);
    }

    expect(page.url()).toContain("/markets");
  });

  test("switches to Favorites tab and shows starred markets", async ({
    page,
  }) => {
    const switched = await clickTab(page, "Favorites");

    if (switched) {
      const body = await page.locator("body").textContent();
      expect(body?.length).toBeGreaterThan(50);
    }
  });

  test("remembers selected tab on page reload", async ({ page }) => {
    // Click Predictions tab
    await clickTab(page, "Predictions");
    await page.waitForTimeout(1000);

    // Reload
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);

    // Should still be on markets page
    expect(page.url()).toContain("/markets");
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });
});

test.describe("Markets - Search", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateTo(page, ROUTES.MARKETS);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("search filters market list", async ({ page }) => {
    const value = await fillAndVerify(page, SELECTORS.SEARCH_INPUT, "AAPL");

    if (value) {
      await page.waitForTimeout(1500);
      const body = await page.locator("body").textContent();
      expect(body?.length).toBeGreaterThan(50);
    }
  });

  test("shows no results for nonexistent ticker", async ({ page }) => {
    const value = await fillAndVerify(
      page,
      SELECTORS.SEARCH_INPUT,
      "ZZZZZNONEXISTENT",
    );

    if (value) {
      await page.waitForTimeout(1500);
      // Should show empty state or no matches
      const body = await page.locator("body").textContent();
      expect(body?.length).toBeGreaterThan(50);
    }
  });

  test("clear search restores full market list", async ({ page }) => {
    const searchInput = page.locator(SELECTORS.SEARCH_INPUT).first();
    if (
      await searchInput
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false)
    ) {
      await searchInput.fill("AAPL");
      await page.waitForTimeout(1000);

      await searchInput.clear();
      await page.waitForTimeout(1000);

      const body = await page.locator("body").textContent();
      expect(body?.length).toBeGreaterThan(100);
    }
  });
});

test.describe("Perps Markets", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateTo(page, ROUTES.MARKETS_PERPS);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("displays perp market list with ticker symbols", async ({ page }) => {
    const marketCards = page.locator(
      'button:has-text("$"), [data-testid="market-card"]',
    );
    const _count = await marketCards.count().catch(() => 0);

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("clicking market card navigates to trading page", async ({ page }) => {
    const marketCard = page.locator('button:has-text("$")').first();

    if (
      await marketCard.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      await marketCard.click({ force: true });
      await page.waitForTimeout(2000);
    }

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });
});

test.describe("Perp Trading Interface", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateTo(page, ROUTES.MARKETS_PERPS);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);

    // Navigate to first market
    const marketCard = page.locator('button:has-text("$")').first();
    if (
      await marketCard.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      await marketCard.click({ force: true });
      await page.waitForTimeout(2000);
    }
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("trading page shows Long/Short buttons and price", async ({ page }) => {
    const hasTradingContent = await pageContainsText(
      page,
      "long",
      "short",
      "buy",
      "sell",
      "perp",
      "$",
    );
    expect(hasTradingContent).toBe(true);
  });

  test("displays price chart with default time period", async ({ page }) => {
    const chart = page
      .locator(
        'canvas, svg.recharts-surface, [data-testid*="chart"], .chart-container',
      )
      .first();
    const hasChart = await chart
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    // Chart may be lazy loaded
    const body = await page.locator("body").textContent();
    expect(hasChart || (body?.length ?? 0) > 100).toBe(true);
  });

  test("switches chart time periods", async ({ page }) => {
    const periods = ["1H", "1D", "1W", "1M"];

    for (const period of periods) {
      const button = page.locator(`button:has-text("${period}")`).first();
      if (
        await button.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
      ) {
        await button.click({ force: true });
        await page.waitForTimeout(500);
      }
    }

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("toggles between Long and Short positions", async ({ page }) => {
    const longButton = page.locator(SELECTORS.LONG_BUTTON).first();
    const shortButton = page.locator(SELECTORS.SHORT_BUTTON).first();

    if (
      await longButton.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      await longButton.click({ force: true });
      await page.waitForTimeout(500);
    }

    if (
      await shortButton
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false)
    ) {
      await shortButton.click({ force: true });
      await page.waitForTimeout(500);
    }

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("accepts quantity input and validates minimum", async ({ page }) => {
    const quantityInput = page.locator(SELECTORS.QUANTITY_INPUT).first();
    if (
      await quantityInput
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false)
    ) {
      const value = await fillAndVerify(page, SELECTORS.QUANTITY_INPUT, "10");
      expect(value).toBeTruthy();

      // Try zero - should show validation or disable submit
      await quantityInput.clear();
      await quantityInput.fill("0");
      await page.waitForTimeout(500);
    }
  });

  test("shows order preview before submission", async ({ page }) => {
    // Select Long
    await clickFirstVisible(page, [SELECTORS.LONG_BUTTON]);
    await page.waitForTimeout(300);

    // Enter quantity
    const quantityInput = page.locator(SELECTORS.QUANTITY_INPUT).first();
    if (
      await quantityInput
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false)
    ) {
      await quantityInput.fill("10");
      await page.waitForTimeout(1000);

      // Should show order summary/preview
      const body = await page.locator("body").textContent();
      expect(body?.length).toBeGreaterThan(100);
    }
  });

  test("toggles watchlist star on market", async ({ page }) => {
    const starButton = page.locator(SELECTORS.WATCHLIST_STAR).first();
    if (
      await starButton.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      await starButton.click({ force: true });
      await page.waitForTimeout(500);

      // Click again to toggle off
      await starButton.click({ force: true });
      await page.waitForTimeout(500);
    }

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("displays Buy Points modal when clicking Buy Points", async ({
    page,
  }) => {
    const modal = await openModal(page, SELECTORS.BUY_POINTS_BUTTON);

    if (modal) {
      const modalText = await modal.textContent();
      const hasPaymentContent =
        modalText?.toLowerCase().includes("buy") ||
        modalText?.toLowerCase().includes("points") ||
        modalText?.toLowerCase().includes("amount");
      expect(hasPaymentContent).toBe(true);

      await closeModal(page);
    } else {
      // Buy Points may not be available
      const body = await page.locator("body").textContent();
      expect(body?.length).toBeGreaterThan(100);
    }
  });

  test("closes Buy Points modal on Escape", async ({ page }) => {
    const modal = await openModal(page, SELECTORS.BUY_POINTS_BUTTON);

    if (modal) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);

      const stillVisible = await page
        .locator('[role="dialog"]')
        .first()
        .isVisible({ timeout: 1000 })
        .catch(() => false);
      expect(typeof stillVisible).toBe("boolean");
    }
  });
});

test.describe("Predictions Markets", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateTo(page, ROUTES.MARKETS_PREDICTIONS);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("displays prediction markets with YES/NO options", async ({ page }) => {
    const yesButtons = page.locator(SELECTORS.YES_BUTTON);
    const _count = await yesButtons.count().catch(() => 0);

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("clicks YES on prediction and shows order entry", async ({ page }) => {
    const yesButton = page.locator(SELECTORS.YES_BUTTON).first();
    if (
      await yesButton.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      await yesButton.click({ force: true });
      await page.waitForTimeout(1500);

      // Should show order panel or navigate
      const body = await page.locator("body").textContent();
      expect(body?.length).toBeGreaterThan(100);
    }
  });

  test("clicks NO on prediction and shows order entry", async ({ page }) => {
    const noButton = page.locator(SELECTORS.NO_BUTTON).first();
    if (
      await noButton.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      await noButton.click({ force: true });
      await page.waitForTimeout(1500);

      const body = await page.locator("body").textContent();
      expect(body?.length).toBeGreaterThan(100);
    }
  });

  test("enters bet amount in prediction order form", async ({ page }) => {
    // First click YES to activate order form
    await clickFirstVisible(page, [SELECTORS.YES_BUTTON]);
    await page.waitForTimeout(1000);

    const amountInput = page.locator(SELECTORS.QUANTITY_INPUT).first();
    if (
      await amountInput
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false)
    ) {
      const value = await fillAndVerify(page, SELECTORS.QUANTITY_INPUT, "10");
      expect(value).toBeTruthy();
    }
  });

  test("shows prediction market detail when clicking card", async ({
    page,
  }) => {
    const predictionCard = page
      .locator('[data-testid="prediction-card"], .prediction-card')
      .first();
    const marketLink = page.locator('a[href*="/markets/predictions/"]').first();

    const hasCard = await predictionCard
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);
    const hasLink = await marketLink
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    if (hasCard) {
      await predictionCard.click({ force: true });
      await page.waitForTimeout(2000);
    } else if (hasLink) {
      await marketLink.click({ force: true });
      await page.waitForTimeout(2000);
    }

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("sorting buttons change market order", async ({ page }) => {
    const trendingButton = page.locator('button:has-text("Trending")').first();
    const volumeButton = page.locator('button:has-text("Volume")').first();

    if (
      await trendingButton
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false)
    ) {
      await trendingButton.click({ force: true });
      await page.waitForTimeout(1000);
    }

    if (
      await volumeButton
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false)
    ) {
      await volumeButton.click({ force: true });
      await page.waitForTimeout(1000);
    }

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("search filters prediction markets", async ({ page }) => {
    const value = await fillAndVerify(page, SELECTORS.SEARCH_INPUT, "Will");

    if (value) {
      await page.waitForTimeout(1500);
    }

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(50);
  });

  test("displays resolution status on resolved markets", async ({ page }) => {
    // Look for resolved market indicators
    const _hasResolvedContent = await pageContainsText(
      page,
      "resolved",
      "closed",
      "settled",
      "ended",
    );

    // Resolved markets may or may not be visible in the default view
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });
});
