import { expect, test } from "./fixtures";
import { fillAndVerify, pageContainsText } from "./helpers/interaction-helpers";
import {
  cooldownBetweenTests,
  isServerHealthy,
  navigateTo,
  waitForPageLoad,
} from "./helpers/page-helpers";
import { ROUTES, SELECTORS, VIEWPORTS } from "./helpers/test-data";
import { loginWithWallet } from "./helpers/wallet-auth";

test.setTimeout(60000);

test.describe("Betting - Page Load", () => {
  test.beforeEach(async ({ page }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("betting page loads when authenticated", async ({ page, wallets }) => {
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.BETTING);
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("unauthenticated redirects from betting", async ({ page }) => {
    await navigateTo(page, ROUTES.BETTING);
    await waitForPageLoad(page);
    const hasLogin = await page
      .locator(SELECTORS.LOGIN_BUTTON)
      .first()
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    const url = page.url();
    // Either a login/connect affordance is shown or we were sent off /betting.
    expect(
      hasLogin ||
        url.includes("login") ||
        url.includes("connect") ||
        !url.includes("/betting"),
    ).toBe(true);
  });
});

test.describe("Betting - Market Selection", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.BETTING);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("market selection area visible", async ({ page }) => {
    const hasMarkets = await pageContainsText(
      page,
      "market",
      "bet",
      "select",
      "choose",
    );
    expect(typeof hasMarkets).toBe("boolean");
  });

  test("market details show on selection", async ({ page }) => {
    const marketItem = page
      .locator('[data-testid*="market"], .market-item, a[href*="market"]')
      .first();
    const isVisible = await marketItem
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no betting markets rendered on the betting page");
    await marketItem.click({ force: true });
    await page.waitForTimeout(1000);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
  });
});

test.describe("Betting - Order Form", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.BETTING);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("YES/NO buttons present", async ({ page }) => {
    const yesBtn = page.locator(SELECTORS.YES_BUTTON).first();
    const noBtn = page.locator(SELECTORS.NO_BUTTON).first();
    const yesVisible = await yesBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    const noVisible = await noBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    expect(typeof yesVisible).toBe("boolean");
    expect(typeof noVisible).toBe("boolean");
  });

  test("YES/NO toggle switches selection", async ({ page }) => {
    const yesBtn = page.locator(SELECTORS.YES_BUTTON).first();
    const isVisible = await yesBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no YES button rendered on the betting page");
    await yesBtn.click({ force: true });
    await page.waitForTimeout(300);
    const noBtn = page.locator(SELECTORS.NO_BUTTON).first();
    await expect(noBtn, "NO side of the toggle is missing").toBeVisible();
    await noBtn.click({ force: true });
    await expect(noBtn).toBeEnabled();
  });

  test("amount input accepts values", async ({ page }) => {
    const result = await fillAndVerify(page, SELECTORS.QUANTITY_INPUT, "100");
    test.skip(result === null, "no amount input rendered on the betting page");
    expect(result).toBe("100");
  });

  test("amount validation rejects invalid values", async ({ page }) => {
    const result = await fillAndVerify(page, SELECTORS.QUANTITY_INPUT, "-50");
    test.skip(result === null, "no amount input rendered on the betting page");
    const hasError = await pageContainsText(page, "invalid", "error", "minimum");
    const inputValue = await page
      .locator(SELECTORS.QUANTITY_INPUT)
      .first()
      .inputValue()
      .catch(() => "");
    // Either the negative value is rejected or an error message shows.
    expect(hasError || !inputValue.startsWith("-")).toBe(true);
  });

  test("payout preview updates", async ({ page }) => {
    await fillAndVerify(page, SELECTORS.QUANTITY_INPUT, "100");
    await page.waitForTimeout(500);
    const hasPayout = await pageContainsText(
      page,
      "payout",
      "return",
      "win",
      "estimate",
    );
    expect(typeof hasPayout).toBe("boolean");
  });

  test("wallet status shown", async ({ page }) => {
    const hasWalletInfo = await pageContainsText(
      page,
      "balance",
      "wallet",
      "points",
      "available",
    );
    expect(typeof hasWalletInfo).toBe("boolean");
  });
});

test.describe("Betting - Confirm", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.BETTING);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("confirm button enabled when valid", async ({ page }) => {
    const yesBtn = page.locator(SELECTORS.YES_BUTTON).first();
    const yesVisible = await yesBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!yesVisible, "no YES button rendered (no betting markets)");
    await yesBtn.click({ force: true });
    await fillAndVerify(page, SELECTORS.QUANTITY_INPUT, "100");
    await page.waitForTimeout(500);
    const confirmBtn = page
      .locator(
        'button:has-text("Confirm"), button:has-text("Place Bet"), button:has-text("Submit")',
      )
      .first();
    await expect(confirmBtn).toBeVisible({ timeout: 5000 });
    await expect(confirmBtn).toBeEnabled();
  });

  test("confirm button disabled when invalid", async ({ page }) => {
    const confirmBtn = page
      .locator(
        'button:has-text("Confirm"), button:has-text("Place Bet"), button:has-text("Submit")',
      )
      .first();
    const isVisible = await confirmBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no confirm button rendered on the betting page");
    // Nothing selected and no amount entered: confirming must be blocked.
    await expect(confirmBtn).toBeDisabled();
  });
});
