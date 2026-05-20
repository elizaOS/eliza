/**
 * E2E test helpers for authentication and common operations.
 *
 * @module testing/e2e/helpers
 */

import type { Page } from "@playwright/test";

/**
 * Gets Privy test account credentials from environment variables.
 *
 * @returns Object containing email and password
 * @throws Error if PRIVY_TEST_EMAIL is not set
 */
export function getPrivyTestAccount() {
  const email = process.env.PRIVY_TEST_EMAIL;
  const password = process.env.PRIVY_TEST_PASSWORD;

  if (!email) {
    throw new Error(
      "PRIVY_TEST_EMAIL environment variable is required for E2E tests",
    );
  }

  return { email, password };
}

/**
 * Authenticates with Privy and waits for successful login.
 *
 * @param page - Playwright page instance
 */
export async function authenticateWithPrivy(page: Page) {
  const { email, password } = getPrivyTestAccount();

  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
  const isAlreadyLoggedIn = await page
    .evaluate(() => {
      const hasUserMenu =
        document.querySelector('[data-testid="user-menu"]') !== null;
      const hasProfile = Array.from(document.querySelectorAll("button")).some(
        (b) => b.textContent?.includes("Profile"),
      );
      const hasToken = window.localStorage.getItem("privy:token") !== null;
      return (hasUserMenu || hasProfile) && hasToken;
    })
    .catch(() => false);

  if (isAlreadyLoggedIn) {
    console.log("✅ Already authenticated - skipping login flow");
    return;
  }

  const loginButton = page
    .locator(
      'button:has-text("Log in"), button:has-text("Sign in"), button:has-text("Login"), button:has-text("Connect")',
    )
    .first();
  const emailInput = page
    .locator(
      'input[type="email"], input[name="email"], input[placeholder*="email" i]',
    )
    .first();

  let isLoginModalOpen = await emailInput
    .isVisible({ timeout: 2000 })
    .catch(() => false);

  if (!isLoginModalOpen) {
    const loginButtonVisible = await loginButton
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (loginButtonVisible) {
      try {
        await loginButton.click({ timeout: 5000 });
      } catch (e) {
        console.log("⚠️  Normal click failed, trying force click...", e);
        await loginButton.click({ force: true });
      }
      await page.waitForTimeout(1000);
      isLoginModalOpen = await emailInput
        .isVisible({ timeout: 5000 })
        .catch(() => false);
    }
  }

  if (!isLoginModalOpen) {
    const loggedInNow = await page
      .evaluate(() => {
        const hasUserMenu =
          document.querySelector('[data-testid="user-menu"]') !== null;
        return hasUserMenu;
      })
      .catch(() => false);

    if (loggedInNow) {
      console.log("✅ Logged in detected late");
      return;
    }

    throw new Error("Could not find login button or open login modal on page");
  }

  await emailInput.fill(email);
  await page.waitForTimeout(500);

  const continueButton = page
    .locator(
      'button:has-text("Continue"), button:has-text("Log in"), button:has-text("Submit"), button[type="submit"]',
    )
    .filter({ hasText: /Continue|Log in|Submit/ })
    .last();

  await continueButton.click();
  await page.waitForTimeout(2000);

  if (password) {
    const passwordInput = page.locator('input[type="password"]').first();
    const passwordVisible = await passwordInput
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (passwordVisible) {
      await passwordInput.fill(password);
      await page.waitForTimeout(500);

      const submitButton = page
        .locator(
          'button:has-text("Log in"), button:has-text("Sign in"), button[type="submit"]',
        )
        .first();
      await submitButton.click();
      await page.waitForTimeout(2000);
    }
  }

  type WindowWithPrivyToken = Window & {
    __privyAccessToken?: unknown;
  };
  await page.waitForFunction(
    () => {
      const win = window as WindowWithPrivyToken;
      const hasAccessToken = win.__privyAccessToken;
      if (hasAccessToken) return true;

      const hasUserMenu =
        document.querySelector('[data-testid="user-menu"]') !== null;
      const hasProfileButton = Array.from(
        document.querySelectorAll("button"),
      ).some((b) => b.textContent?.includes("Profile"));
      const hasPrivyToken = window.localStorage.getItem("privy:token") !== null;

      return (hasUserMenu || hasProfileButton) && hasPrivyToken;
    },
    { timeout: 30000 },
  );

  console.log("✅ Authentication successful");
}
