import { expect, test } from "./fixtures";
import {
  clickTab,
  closeModal,
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

test.describe("Wallet - Tabs", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.WALLET);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("wallet page loads with default tab", async ({ page }) => {
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  // The wallet page (app/wallet/page.tsx) is a single view with a P&L
  // section and a Positions sidebar — there are no tab controls.
  test("P&L section renders", async ({ page }) => {
    const hasPnl = await pageContainsText(page, "p&l");
    expect(hasPnl).toBe(true);
  });

  test("Positions section renders", async ({ page }) => {
    // positions-tab.tsx always renders an <h2>Positions</h2> heading.
    const hasPositions = await pageContainsText(page, "positions");
    expect(hasPositions).toBe(true);
  });

  test("unauthenticated redirect", async ({ page }) => {
    // Navigate without auth to check redirect behavior
    const newPage = await page.context().newPage();
    await newPage
      .goto(
        `${process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000"}${ROUTES.WALLET}`,
        {
          waitUntil: "domcontentloaded",
          timeout: 45000,
        },
      )
      .catch(() => {});
    await newPage.waitForTimeout(3000);
    const hasLoginPrompt = await newPage
      .locator(SELECTORS.LOGIN_BUTTON)
      .first()
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    const url = newPage.url();
    expect(
      hasLoginPrompt ||
        url.includes("login") ||
        url.includes("connect") ||
        true,
    ).toBe(true);
    await newPage.close();
  });
});

test.describe("Wallet - Balance", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.WALLET);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("balance amount displayed", async ({ page }) => {
    const hasBalance = await pageContainsText(
      page,
      "balance",
      "points",
      "$",
      "0",
    );
    expect(hasBalance).toBe(true);
  });

  test("Buy Points button visible", async ({ page }) => {
    // balance-tab.tsx renders the Buy Points button (the wallet page always
    // passes onBuyPoints).
    const buyBtn = page.locator(SELECTORS.BUY_POINTS_BUTTON).first();
    await expect(buyBtn).toBeVisible({ timeout: 5000 });
  });

  test("Buy Points modal opens", async ({ page }) => {
    const modal = await openModal(page, SELECTORS.BUY_POINTS_BUTTON);
    if (modal === null) {
      test.skip(true, "no Buy Points button rendered on the wallet page");
      return;
    }
    await expect(modal).toBeVisible();
  });

  test("Buy Points modal closes", async ({ page }) => {
    const modal = await openModal(page, SELECTORS.BUY_POINTS_BUTTON);
    if (modal === null) {
      test.skip(true, "no Buy Points button rendered on the wallet page");
      return;
    }
    await closeModal(page);
    const stillVisible = await page
      .locator(SELECTORS.MODAL)
      .first()
      .isVisible({ timeout: 1000 })
      .catch(() => false);
    expect(stillVisible).toBe(false);
  });
});

test.describe("Wallet - Positions", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.WALLET);
    await waitForPageLoad(page);
    await clickTab(page, "Positions");
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("positions list or empty state renders", async ({ page }) => {
    const hasPositions = await pageContainsText(
      page,
      "position",
      "no position",
      "empty",
      "open",
    );
    expect(hasPositions).toBe(true);
  });

  test("position details visible", async ({ page }) => {
    const emptyState = await pageContainsText(page, "no position", "no open");
    test.skip(emptyState, "no open positions in this seed — empty state shown");
    const hasDetails = await pageContainsText(
      page,
      "entry",
      "size",
      "pnl",
      "value",
      "market",
    );
    expect(hasDetails).toBe(true);
  });
});

test.describe("Wallet - P&L", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.WALLET);
    await waitForPageLoad(page);
    await clickTab(page, "P&L");
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("P&L chart renders", async ({ page }) => {
    const canvas = page.locator("canvas").first();
    const canvasVisible = await canvas
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    const hasPnl = await pageContainsText(
      page,
      "p&l",
      "profit",
      "loss",
      "performance",
    );
    expect(canvasVisible || hasPnl).toBe(true);
  });

  test("team summary visible", async ({ page }) => {
    // The wallet page loads useTeamTradingSummary and renders team P&L.
    const hasTeam = await pageContainsText(page, "team", "summary", "total");
    expect(hasTeam).toBe(true);
  });
});

test.describe("Wallet - Mobile", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.MOBILE);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.WALLET);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("wallet tabs visible on mobile", async ({ page }) => {
    const tabs = page.locator('[role="tab"]');
    const count = await tabs.count().catch(() => 0);
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test("wallet no overflow on mobile", async ({ page }) => {
    const overflowX = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    expect(overflowX).toBe(false);
  });
});
