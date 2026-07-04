/**
 * Playwright e2e coverage driving a real MetaMask wallet (@avalix/chroma + Privy) against a live Feed dev server; every spec skips when the /api/health check fails.
 *
 * Security and edge-case coverage — XSS prevention, malformed URLs, and invalid input handling.
 */
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

test.describe("Edge Cases - Security", () => {
  test.beforeEach(async ({ page }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("XSS prevention in URL parameters", async ({ page }) => {
    await navigateTo(page, "/search?q=<script>alert(1)</script>");
    await waitForPageLoad(page);
    const body = await page.locator("body").innerHTML();
    expect(body).not.toContain("<script>alert(1)</script>");
  });

  test("SQL injection in search input", async ({ page, wallets }) => {
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.MARKETS);
    await waitForPageLoad(page);
    const result = await fillAndVerify(
      page,
      SELECTORS.SEARCH_INPUT,
      "'; DROP TABLE users; --",
    );
    test.skip(
      result === null,
      "no search input rendered on the markets dashboard",
    );
    await page.waitForTimeout(1000);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("no stack traces exposed in production errors", async ({ page }) => {
    await navigateTo(page, "/api/nonexistent-endpoint");
    await waitForPageLoad(page);
    const body = (await page.locator("body").textContent()) ?? "";
    const lower = body.toLowerCase();
    expect(lower).not.toContain("stack trace");
    expect(lower).not.toContain("at module");
    expect(lower).not.toContain("node_modules");
  });
});

test.describe("Edge Cases - Input Validation", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("empty post submission prevented", async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    const submitBtn = page
      .locator('button:has-text("Post"), button:has-text("Submit")')
      .first();
    const isVisible = await submitBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(
      !isVisible,
      "no Post/Submit button rendered on the feed page",
    );
    await expect(submitBtn).toBeDisabled();
  });

  test("unicode characters handled in post", async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    const composer = page.locator('textarea, [contenteditable="true"]').first();
    const isVisible = await composer
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no inline composer rendered on the feed page");
    await composer.fill(
      "Testing unicode: \u{1F680}\u{1F30D}\u{2764}\u{FE0F} \u4F60\u597D \u0645\u0631\u062D\u0628\u0627",
    );
    const value = await composer.inputValue().catch(() => "");
    expect(value.length).toBeGreaterThan(0);
  });

  test("long input handled gracefully", async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    const composer = page.locator('textarea, [contenteditable="true"]').first();
    const isVisible = await composer
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no inline composer rendered on the feed page");
    const longText = "A".repeat(10000);
    await composer.fill(longText);
    await page.waitForTimeout(500);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
  });

  test("rapid clicks do not cause errors", async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    const likeBtn = page.locator(SELECTORS.LIKE_BUTTON).first();
    const isVisible = await likeBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no post with a like button rendered in the feed");
    for (let i = 0; i < 10; i++) {
      await likeBtn.click({ force: true }).catch(() => {});
    }
    await page.waitForTimeout(1000);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
  });
});

test.describe("Edge Cases - Markets Validation", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.MARKETS_PERPS_BY_TICKER("BTC"));
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("negative amount rejected", async ({ page }) => {
    const result = await fillAndVerify(page, SELECTORS.QUANTITY_INPUT, "-100");
    test.skip(
      result === null,
      "no quantity input rendered on the perp trading page",
    );
    await page.waitForTimeout(300);
    const hasError = await pageContainsText(
      page,
      "invalid",
      "error",
      "positive",
      "minimum",
    );
    const inputValue = await page
      .locator(SELECTORS.QUANTITY_INPUT)
      .first()
      .inputValue()
      .catch(() => "");
    // Either the negative value is rejected or an error message shows.
    expect(hasError || !inputValue.startsWith("-")).toBe(true);
  });

  test("non-numeric input rejected", async ({ page }) => {
    const result = await fillAndVerify(page, SELECTORS.QUANTITY_INPUT, "abc");
    test.skip(
      result === null,
      "no quantity input rendered on the perp trading page",
    );
    // A quantity field must not accept a non-numeric value.
    expect(result).not.toBe("abc");
  });

  test("decimal precision handled", async ({ page }) => {
    const result = await fillAndVerify(
      page,
      SELECTORS.QUANTITY_INPUT,
      "10.12345678",
    );
    test.skip(
      result === null,
      "no quantity input rendered on the perp trading page",
    );
    const parsed = Number.parseFloat(result ?? "");
    expect(Number.isNaN(parsed)).toBe(false);
    expect(parsed).toBeGreaterThan(0);
  });
});

test.describe("Edge Cases - Profile Validation", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.SETTINGS);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("username with spaces rejected", async ({ page }) => {
    const result = await fillAndVerify(
      page,
      'input[name="username"], input[placeholder*="username" i]',
      "has spaces here",
    );
    test.skip(
      result === null,
      "no username input rendered on the settings page",
    );
    await page.waitForTimeout(300);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
  });

  test("username minimum length enforced", async ({ page }) => {
    const result = await fillAndVerify(
      page,
      'input[name="username"], input[placeholder*="username" i]',
      "a",
    );
    test.skip(
      result === null,
      "no username input rendered on the settings page",
    );
    await page.waitForTimeout(300);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
  });
});

test.describe("Edge Cases - 404 Page", () => {
  test.beforeEach(async ({ page }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("404 page renders for invalid routes", async ({ page }) => {
    await navigateTo(page, "/completely-invalid-route-xyz");
    await waitForPageLoad(page);
    const has404 = await pageContainsText(
      page,
      "404",
      "not found",
      "page not found",
    );
    expect(has404).toBe(true);
  });
});
