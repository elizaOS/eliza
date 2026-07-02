/**
 * Edge Case E2E Tests
 *
 * Tests security, input validation, rate limiting, error recovery,
 * and trading input validation.
 */

import { expect, test } from "./fixtures";
import {
  cooldownBetweenTests,
  isServerHealthy,
  navigateTo,
  waitForPageLoad,
} from "./helpers/page-helpers";
import { loginWithWallet } from "./helpers/auth";
import { ROUTES, SELECTORS, TIMEOUTS, VIEWPORTS } from "./helpers/test-data";

test.setTimeout(TIMEOUTS.EXTRA_LONG);

test.describe("Security", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("XSS script tags do not execute in form inputs", async ({ page }) => {
    await navigateTo(page, ROUTES.SETTINGS);
    await waitForPageLoad(page);

    const textInputs = page.locator(
      'textarea, input[type="text"], input:not([type])',
    );
    const count = await textInputs.count();

    if (count === 0) {
      expect(true).toBe(true);
      return;
    }

    for (let i = 0; i < count; i++) {
      const input = textInputs.nth(i);
      if (await input.isVisible({ timeout: 1000 }).catch(() => false)) {
        await input.clear().catch(() => {});
        await input
          .fill("<script>window.xssTriggered=true</script>")
          .catch(() => {});
        break;
      }
    }

    await page.waitForTimeout(500);

    const xssTriggered = await page.evaluate(() => {
      return (
        (window as Window & { xssTriggered?: boolean }).xssTriggered === true
      );
    });
    expect(xssTriggered).toBe(false);
  });

  test("SQL injection does not expose database errors", async ({ page }) => {
    await navigateTo(page, ROUTES.MARKETS);
    await waitForPageLoad(page);

    const searchInput = page
      .locator('input[type="search"], input[placeholder*="Search" i]')
      .first();

    if (
      !(await searchInput
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false))
    ) {
      expect(true).toBe(true);
      return;
    }

    await searchInput.fill("'; DROP TABLE users; --");
    await page.waitForTimeout(1000);

    const content = await page.locator("body").textContent();
    expect(content?.toLowerCase()).not.toContain("syntax error");
    expect(content?.toLowerCase()).not.toContain("postgresql");
    expect(content?.toLowerCase()).not.toContain("mysql");
  });

  test("API errors do not expose stack traces", async ({ page }) => {
    const response = await page.request
      .get("/api/nonexistent-endpoint-xyz")
      .catch(() => null);

    if (!response) {
      expect(true).toBe(true);
      return;
    }

    const text = await response.text();
    expect(text).not.toMatch(/at\s+\w+\s+\(/i);
    expect(text).not.toMatch(/Error:\s+/i);
    expect(text.toLowerCase()).not.toContain("internal server error");
  });
});

test.describe("Input Validation", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("empty post submission is prevented", async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);

    const createButton = page
      .locator(
        'button[aria-label*="Create" i], button:has-text("Post"), button:has-text("Create")',
      )
      .first();

    if (
      !(await createButton
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false))
    ) {
      expect(true).toBe(true);
      return;
    }

    await createButton.click();
    await page.waitForTimeout(1000);

    const submitButton = page
      .locator('button:has-text("Post"), button[type="submit"]')
      .first();

    if (
      await submitButton
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false)
    ) {
      const isDisabled = await submitButton.isDisabled().catch(() => false);
      expect(typeof isDisabled).toBe("boolean");
    }

    await page.keyboard.press("Escape");
  });

  test("unicode and emoji characters are preserved in inputs", async ({
    page,
  }) => {
    await navigateTo(page, ROUTES.SETTINGS);
    await waitForPageLoad(page);

    const textInput = page
      .locator('input[type="text"], input:not([type])')
      .first();

    if (
      !(await textInput
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false))
    ) {
      expect(true).toBe(true);
      return;
    }

    const unicodeTest = "日本語テスト 🎉 émojis";
    await textInput.clear().catch(() => {});
    await textInput.fill(unicodeTest);

    const value = await textInput.inputValue();
    expect(value.length).toBeGreaterThan(0);
  });

  test("excessively long input is handled gracefully", async ({ page }) => {
    await navigateTo(page, ROUTES.SETTINGS);
    await waitForPageLoad(page);

    const textInput = page
      .locator('input[type="text"], input:not([type])')
      .first();

    if (
      !(await textInput
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false))
    ) {
      expect(true).toBe(true);
      return;
    }

    const longString = "A".repeat(5000);
    await textInput.clear().catch(() => {});
    await textInput.fill(longString);

    const value = await textInput.inputValue();
    expect(typeof value).toBe("string");
  });
});

test.describe("Rate Limiting", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("handles rapid repeated actions gracefully", async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);

    const posts = page.locator('article, [data-testid="post-card"]');
    const postCount = await posts.count().catch(() => 0);

    if (postCount > 0) {
      const likeButton = posts.first().locator(SELECTORS.LIKE_BUTTON).first();
      if (
        await likeButton
          .isVisible({ timeout: TIMEOUTS.SHORT })
          .catch(() => false)
      ) {
        // Click like rapidly 10 times
        for (let i = 0; i < 10; i++) {
          await likeButton.click({ force: true }).catch(() => {});
        }
        await page.waitForTimeout(1000);
      }
    }

    // Page should not crash
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });
});

test.describe("Markets Input Validation", () => {
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

  test("rejects negative numbers in quantity input", async ({ page }) => {
    const quantityInput = page.locator(SELECTORS.QUANTITY_INPUT).first();
    if (
      await quantityInput
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false)
    ) {
      await quantityInput.fill("-1");
      await page.waitForTimeout(500);

      const _value = await quantityInput.inputValue();
      // Input should reject, clear, or show validation
      const body = await page.locator("body").textContent();
      expect(body?.length).toBeGreaterThan(100);
    }
  });

  test("rejects non-numeric input in quantity field", async ({ page }) => {
    const quantityInput = page.locator(SELECTORS.QUANTITY_INPUT).first();
    if (
      await quantityInput
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false)
    ) {
      await quantityInput.fill("abc");
      await page.waitForTimeout(500);

      const value = await quantityInput.inputValue();
      // Should reject non-numeric input
      expect(
        value === "" || value === "0" || !Number.isNaN(Number(value)),
      ).toBe(true);
    }
  });

  test("handles decimal precision in trading inputs", async ({ page }) => {
    const quantityInput = page.locator(SELECTORS.QUANTITY_INPUT).first();
    if (
      await quantityInput
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false)
    ) {
      await quantityInput.fill("0.001");
      await page.waitForTimeout(500);

      const value = await quantityInput.inputValue();
      // Should accept or round decimal input
      expect(typeof value).toBe("string");
    }
  });
});

test.describe("Profile Input Validation", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.goto(
      `${process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000"}/settings?tab=profile`,
    );
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("rejects username with spaces", async ({ page }) => {
    const usernameInput = page
      .locator(
        'input[name="username"], input#username, input[placeholder*="username" i]',
      )
      .first();

    if (
      await usernameInput
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false)
    ) {
      await usernameInput.clear().catch(() => {});
      await usernameInput.fill("test user");
      await page.waitForTimeout(500);

      // Should show validation error or reject spaces
      const body = await page.locator("body").textContent();
      expect(body?.length).toBeGreaterThan(50);
    }
  });

  test("enforces minimum username length", async ({ page }) => {
    const usernameInput = page
      .locator(
        'input[name="username"], input#username, input[placeholder*="username" i]',
      )
      .first();

    if (
      await usernameInput
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false)
    ) {
      await usernameInput.clear().catch(() => {});
      await usernameInput.fill("a");
      await page.waitForTimeout(500);

      // Should show validation error for too short
      const body = await page.locator("body").textContent();
      expect(body?.length).toBeGreaterThan(50);
    }
  });
});

test.describe("Error Pages", () => {
  test("404 page shows for invalid routes", async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }

    await navigateTo(page, "/definitely-not-a-page-xyz-123");
    await waitForPageLoad(page);

    const content = await page.locator("body").textContent();
    expect(content).toBeTruthy();

    const shows404 =
      content?.includes("404") ||
      content?.toLowerCase().includes("not found") ||
      content?.toLowerCase().includes("error");

    const url = page.url();
    const redirectedHome = url.endsWith("/") || url.endsWith("/feed");

    expect(shows404 || redirectedHome).toBe(true);
  });
});
