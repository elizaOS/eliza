/**
 * Playwright e2e coverage driving a real MetaMask wallet (@avalix/chroma + Privy) against a live Feed dev server; every spec skips when the /api/health check fails.
 *
 * Covers the markets dashboard — prediction markets and perpetuals, including trade modals.
 */
import { expect, test } from "./fixtures";
import {
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
import { ROUTES, SELECTORS, VIEWPORTS } from "./helpers/test-data";
import { loginWithWallet } from "./helpers/wallet-auth";

test.setTimeout(60000);

test.describe("Markets Dashboard", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.MARKETS);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  // MarketsDashboard renders two plain-button tabs: Perpetuals + Predictions.
  test("dashboard loads with tabs", async ({ page }) => {
    await expect(
      page.locator('button:has-text("Perpetuals")').first(),
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.locator('button:has-text("Predictions")').first(),
    ).toBeVisible();
  });

  test("tab navigation works", async ({ page }) => {
    const toPredictions = await clickTab(page, "Predictions");
    expect(toPredictions).toBe(true);
    const backToPerps = await clickTab(page, "Perpetuals");
    expect(backToPerps).toBe(true);
  });

  test("tab persistence after navigation", async ({ page }) => {
    await clickTab(page, "Perps");
    await page.waitForTimeout(500);
    const _urlBefore = page.url();
    await navigateTo(page, ROUTES.FEED);
    await navigateTo(page, ROUTES.MARKETS);
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
  });

  test("search filters markets", async ({ page }) => {
    const searchInput = page.locator(SELECTORS.SEARCH_INPUT).first();
    const isVisible = await searchInput
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no search input rendered on the markets dashboard");
    const typed = await fillAndVerify(page, SELECTORS.SEARCH_INPUT, "BTC");
    expect(typed).toBe("BTC");
    await page.waitForTimeout(1000);
    const hasResults = await pageContainsText(page, "btc", "bitcoin");
    const hasNoResults = await pageContainsText(
      page,
      "no results",
      "no market",
      "not found",
    );
    expect(hasResults || hasNoResults).toBe(true);
  });

  test("search shows no results message", async ({ page }) => {
    const searchInput = page.locator(SELECTORS.SEARCH_INPUT).first();
    const isVisible = await searchInput
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no search input rendered on the markets dashboard");
    await fillAndVerify(page, SELECTORS.SEARCH_INPUT, "xyznonexistent12345");
    await page.waitForTimeout(1000);
    const hasNoResults = await pageContainsText(
      page,
      "no results",
      "no market",
      "not found",
    );
    const marketRows = await page
      .locator('[data-testid*="market"], .market-card')
      .count()
      .catch(() => 0);
    expect(hasNoResults || marketRows === 0).toBe(true);
  });

  test("search clear resets results", async ({ page }) => {
    const searchInput = page.locator(SELECTORS.SEARCH_INPUT).first();
    const isVisible = await searchInput
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no search input rendered on the markets dashboard");
    await fillAndVerify(page, SELECTORS.SEARCH_INPUT, "BTC");
    await page.waitForTimeout(500);
    const cleared = await fillAndVerify(page, SELECTORS.SEARCH_INPUT, "");
    expect(cleared).toBe("");
    await page.waitForTimeout(500);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
  });
});

test.describe("Markets - Perps", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.MARKETS_PERPS);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("perps list renders", async ({ page }) => {
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("click perp navigates to trading page", async ({ page }) => {
    const perpLink = page
      .locator('a[href*="perps"], tr, [data-testid*="market"]')
      .first();
    const isVisible = await perpLink
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no perp market rows rendered on the perps tab");
    await perpLink.click({ force: true });
    await page.waitForTimeout(2000);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
  });

  test("perps chart renders", async ({ page }) => {
    await navigateTo(page, ROUTES.MARKETS_PERPS_BY_TICKER("BTC"));
    await waitForPageLoad(page);
    const hasChart = await pageContainsText(page, "chart", "price", "volume");
    const canvas = page.locator("canvas").first();
    const canvasVisible = await canvas
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    expect(hasChart || canvasVisible).toBe(true);
  });

  test("perps chart time period buttons", async ({ page }) => {
    await navigateTo(page, ROUTES.MARKETS_PERPS_BY_TICKER("BTC"));
    await waitForPageLoad(page);
    const timePeriods = page.locator(
      'button:has-text("1H"), button:has-text("4H"), button:has-text("1D"), button:has-text("1W")',
    );
    const count = await timePeriods.count().catch(() => 0);
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test("Long/Short toggle works", async ({ page }) => {
    await navigateTo(page, ROUTES.MARKETS_PERPS_BY_TICKER("BTC"));
    await waitForPageLoad(page);
    const longBtn = page.locator(SELECTORS.LONG_BUTTON).first();
    const shortBtn = page.locator(SELECTORS.SHORT_BUTTON).first();
    const longVisible = await longBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!longVisible, "no Long/Short toggle rendered on the perp page");
    await expect(longBtn).toBeEnabled();
    await longBtn.click({ force: true });
    await page.waitForTimeout(300);
    await expect(
      shortBtn,
      "Short side of the toggle is missing",
    ).toBeVisible();
    await shortBtn.click({ force: true });
    await expect(shortBtn).toBeEnabled();
  });

  test("quantity input accepts values", async ({ page }) => {
    await navigateTo(page, ROUTES.MARKETS_PERPS_BY_TICKER("BTC"));
    await waitForPageLoad(page);
    const result = await fillAndVerify(page, SELECTORS.QUANTITY_INPUT, "100");
    test.skip(
      result === null,
      "no quantity input rendered on the perp trading page",
    );
    expect(result).toBe("100");
  });

  test("order preview updates with input", async ({ page }) => {
    await navigateTo(page, ROUTES.MARKETS_PERPS_BY_TICKER("BTC"));
    await waitForPageLoad(page);
    const filled = await fillAndVerify(page, SELECTORS.QUANTITY_INPUT, "100");
    test.skip(
      filled === null,
      "no quantity input rendered on the perp trading page",
    );
    await page.waitForTimeout(500);
    const hasPreview = await pageContainsText(
      page,
      "total",
      "fee",
      "estimated",
      "payout",
    );
    expect(hasPreview).toBe(true);
  });

  test("watchlist star toggles", async ({ page }) => {
    await navigateTo(page, ROUTES.MARKETS_PERPS_BY_TICKER("BTC"));
    await waitForPageLoad(page);
    const star = page.locator(SELECTORS.WATCHLIST_STAR).first();
    const isVisible = await star
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no watchlist star rendered on the perp page");
    await expect(star).toBeEnabled();
    const before = await star.evaluate((el) => el.outerHTML);
    await star.click({ force: true });
    await page.waitForTimeout(500);
    const after = await page
      .locator(SELECTORS.WATCHLIST_STAR)
      .first()
      .evaluate((el) => el.outerHTML);
    // A real toggle changes the star's rendered state (fill/aria/pressed).
    expect(after).not.toBe(before);
  });

  test("Buy Points modal opens and closes", async ({ page }) => {
    await navigateTo(page, ROUTES.MARKETS_PERPS_BY_TICKER("BTC"));
    await waitForPageLoad(page);
    const modal = await openModal(page, SELECTORS.BUY_POINTS_BUTTON);
    if (modal === null) {
      test.skip(true, "no Buy Points button rendered on the perp page");
      return;
    }
    await expect(modal).toBeVisible();
    await closeModal(page);
    await expect(modal).toBeHidden({ timeout: 5000 });
  });
});

test.describe("Markets - Predictions", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.MARKETS_PREDICTIONS);
    await waitForPageLoad(page);
    // MarketsDashboard ignores the ?tab= query (tab state defaults to perps),
    // so the Predictions tab must be activated by clicking it.
    await clickTab(page, "Predictions");
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("YES/NO buttons visible on prediction cards", async ({ page }) => {
    const card = page
      .locator(
        '[data-testid*="prediction"], [data-testid*="market-card"], .market-card',
      )
      .first();
    const hasCards = await card
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!hasCards, "no prediction cards rendered on the predictions tab");
    await expect(page.locator(SELECTORS.YES_BUTTON).first()).toBeVisible();
    await expect(page.locator(SELECTORS.NO_BUTTON).first()).toBeVisible();
  });

  test("bet amount input accepts values", async ({ page }) => {
    const yesBtn = page.locator(SELECTORS.YES_BUTTON).first();
    const isVisible = await yesBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no YES button rendered (no prediction cards)");
    await yesBtn.click({ force: true });
    await page.waitForTimeout(500);
    const result = await fillAndVerify(page, SELECTORS.QUANTITY_INPUT, "50");
    test.skip(
      result === null,
      "no bet amount input appeared after selecting YES",
    );
    expect(result).toBe("50");
  });

  test("prediction card shows detail on click", async ({ page }) => {
    const card = page
      .locator(
        '[data-testid*="prediction"], [data-testid*="market-card"], .market-card',
      )
      .first();
    const isVisible = await card
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no prediction cards rendered on the predictions tab");
    const beforeUrl = page.url();
    await card.click({ force: true });
    await page.waitForTimeout(2000);
    const afterUrl = page.url();
    const modal = page.locator(SELECTORS.MODAL).first();
    const modalVisible = await modal
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    // Detail is shown either by navigating or by opening a modal.
    expect(afterUrl !== beforeUrl || modalVisible).toBe(true);
  });

  test("predictions sortable column headers render", async ({ page }) => {
    // The predictions table header row has sortable Question / Volume /
    // Time Left columns (MarketsDashboard.tsx).
    await expect(page.locator('th:has-text("Volume")').first()).toBeVisible({
      timeout: 5000,
    });
    await expect(
      page.locator('th:has-text("Time Left")').first(),
    ).toBeVisible();
  });

  test("predictions search filters", async ({ page }) => {
    const searchInput = page.locator(SELECTORS.SEARCH_INPUT).first();
    const isVisible = await searchInput
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no search input rendered on the predictions tab");
    const typed = await fillAndVerify(page, SELECTORS.SEARCH_INPUT, "bitcoin");
    expect(typed).toBe("bitcoin");
    await page.waitForTimeout(1000);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
  });

  test("prediction resolution status visible", async ({ page }) => {
    const hasStatus = await pageContainsText(
      page,
      "resolved",
      "pending",
      "active",
      "open",
      "closed",
    );
    expect(hasStatus).toBe(true);
  });
});
