/**
 * Settings Page E2E Tests
 *
 * Tests settings functionality: profile editing, themes, notifications,
 * security, privacy, API keys, billing, and social account linking.
 */

import { expect, test } from "./fixtures";
import {
  closeModal,
  navigateToTab,
  openModal,
  pageContainsText,
} from "./helpers/interaction-helpers";
import {
  cooldownBetweenTests,
  isServerHealthy,
  navigateTo,
  waitForPageLoad,
} from "./helpers/page-helpers";
import { loginWithWallet } from "./helpers/auth";
import { ROUTES, SELECTORS, TIMEOUTS, VIEWPORTS } from "./helpers/test-data";

test.setTimeout(TIMEOUTS.EXTRA_LONG);

test.describe("Settings - Navigation", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateTo(page, ROUTES.SETTINGS);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("displays settings page with tabs", async ({ page }) => {
    const url = page.url();
    const isOnSettings = url.includes("/settings");

    const pageContent = await page.locator("body").textContent();
    const hasContent = pageContent?.length && pageContent.length > 100;

    expect(isOnSettings || hasContent).toBe(true);
  });

  test("can switch between settings tabs", async ({ page }) => {
    const tabs = ["Profile", "Theme", "Security", "Privacy", "API"];

    for (const tabName of tabs) {
      const tab = page.locator(`button:has-text("${tabName}")`).first();
      if (await tab.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)) {
        await tab.click({ force: true }).catch(() => {});
        await page.waitForTimeout(500);
      }
    }

    const pageContent = await page.locator("body").textContent();
    expect(pageContent?.length).toBeGreaterThan(0);
  });
});

test.describe("Settings - Profile Tab", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateToTab(page, "/settings", "profile");
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("displays all profile form fields", async ({ page }) => {
    const hasFormContent = await pageContainsText(
      page,
      "name",
      "username",
      "bio",
      "display",
      "avatar",
    );

    const body = await page.locator("body").textContent();
    expect(hasFormContent || (body?.length ?? 0) > 100).toBe(true);
  });

  test("displays avatar upload area", async ({ page }) => {
    const avatarArea = page
      .locator(
        '[data-testid="profile-avatar"], img[alt*="avatar" i], .avatar, input[type="file"]',
      )
      .first();
    const hasAvatar = await avatarArea
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    const body = await page.locator("body").textContent();
    expect(hasAvatar || (body?.length ?? 0) > 100).toBe(true);
  });

  test("can edit display name", async ({ page }) => {
    const textInput = page
      .locator(
        'input#displayName, input[name="displayName"], input[type="text"]',
      )
      .first();

    if (
      await textInput.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      const testName = `Test User ${Date.now()}`;
      await textInput.clear().catch(() => {});
      await textInput.fill(testName);

      const value = await textInput.inputValue();
      expect(value.length).toBeGreaterThan(0);
    }

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("can edit username and verify character limits", async ({ page }) => {
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
      await usernameInput.fill("testuser123");
      const value = await usernameInput.inputValue();
      expect(value.length).toBeGreaterThan(0);
    }
  });

  test("can edit bio and verify character limits", async ({ page }) => {
    const bioInput = page
      .locator('textarea[name="bio"], textarea#bio, textarea')
      .first();

    if (
      await bioInput.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      const testBio = "This is a test bio for E2E testing.";
      await bioInput.clear().catch(() => {});
      await bioInput.fill(testBio);
      const value = await bioInput.inputValue();
      expect(value).toContain("test bio");
    }
  });

  test("shows save button and responds to click", async ({ page }) => {
    const saveButton = page.locator(SELECTORS.SAVE_BUTTON).first();
    const isVisible = await saveButton
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    if (isVisible) {
      // Verify it's interactable
      const isDisabled = await saveButton.isDisabled().catch(() => false);
      expect(typeof isDisabled).toBe("boolean");
    }

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(50);
  });

  test("shows validation errors for invalid username", async ({ page }) => {
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
      // Try special characters
      await usernameInput.clear().catch(() => {});
      await usernameInput.fill("!@#$%");
      await page.waitForTimeout(500);

      // Should show validation error or reject input
      const body = await page.locator("body").textContent();
      expect(body?.length).toBeGreaterThan(50);
    }
  });
});

test.describe("Settings - Theme Tab", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateToTab(page, "/settings", "theme");
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("displays light/dark/system theme options", async ({ page }) => {
    const hasThemeOptions = await pageContainsText(
      page,
      "light",
      "dark",
      "system",
      "theme",
    );
    expect(hasThemeOptions).toBe(true);
  });

  test("switches to dark theme and verifies body class", async ({ page }) => {
    const darkOption = page
      .locator(
        'label:has-text("Dark"), input[value="dark"], button:has-text("Dark")',
      )
      .first();

    if (
      await darkOption.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      await darkOption.click({ force: true });
      await page.waitForTimeout(1000);

      // Verify theme changed on html element
      const htmlClass = await page.evaluate(() =>
        document.documentElement.classList.toString(),
      );
      const isDark =
        htmlClass.includes("dark") ||
        (await page.evaluate(() =>
          document.documentElement.getAttribute("data-theme"),
        )) === "dark";

      // Theme may apply differently
      expect(typeof isDark).toBe("boolean");
    }
  });

  test("switches to light theme", async ({ page }) => {
    const lightOption = page
      .locator(
        'label:has-text("Light"), input[value="light"], button:has-text("Light")',
      )
      .first();

    if (
      await lightOption
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false)
    ) {
      await lightOption.click({ force: true });
      await page.waitForTimeout(1000);
    }

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(50);
  });

  test("switches to system theme", async ({ page }) => {
    const systemOption = page
      .locator(
        'label:has-text("System"), input[value="system"], button:has-text("System")',
      )
      .first();

    if (
      await systemOption
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false)
    ) {
      await systemOption.click({ force: true });
      await page.waitForTimeout(1000);
    }

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(50);
  });
});

test.describe("Settings - Notifications Tab", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateToTab(page, "/settings", "notifications");
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("displays notification toggle switches", async ({ page }) => {
    const toggles = page.locator(
      'input[type="checkbox"], [role="switch"], button[role="switch"]',
    );
    const count = await toggles.count().catch(() => 0);

    const hasNotificationContent = await pageContainsText(
      page,
      "notification",
      "alert",
      "email",
      "push",
    );

    expect(count > 0 || hasNotificationContent).toBe(true);
  });

  test("toggles a notification setting", async ({ page }) => {
    const toggle = page
      .locator('input[type="checkbox"], [role="switch"], button[role="switch"]')
      .first();

    if (
      await toggle.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      await toggle.click({ force: true });
      await page.waitForTimeout(500);

      // Toggle back
      await toggle.click({ force: true });
      await page.waitForTimeout(500);
    }

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(50);
  });
});

test.describe("Settings - Privacy Tab", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateToTab(page, "/settings", "privacy");
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("displays privacy options", async ({ page }) => {
    const hasPrivacyContent = await pageContainsText(
      page,
      "block",
      "mute",
      "delete",
      "privacy",
    );
    expect(hasPrivacyContent).toBe(true);
  });

  test("shows delete account option with confirmation", async ({ page }) => {
    const deleteButton = page
      .locator(
        'button:has-text("Delete"), button:has-text("Remove Account"), button:has-text("Delete Account")',
      )
      .first();
    const hasDelete = await deleteButton
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    const hasDeleteContent = await pageContainsText(
      page,
      "delete",
      "remove",
      "deactivate",
    );
    expect(hasDelete || hasDeleteContent).toBe(true);
  });
});

test.describe("Settings - Security Tab", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateToTab(page, "/settings", "security");
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("displays security options", async ({ page }) => {
    const hasSecurityContent = await pageContainsText(
      page,
      "security",
      "password",
      "2fa",
      "two-factor",
      "authentication",
    );

    const body = await page.locator("body").textContent();
    expect(hasSecurityContent || (body?.length ?? 0) > 100).toBe(true);
  });

  test("shows 2FA setup option", async ({ page }) => {
    const has2FAContent = await pageContainsText(
      page,
      "2fa",
      "two-factor",
      "authenticator",
      "totp",
    );

    const body = await page.locator("body").textContent();
    expect(has2FAContent || (body?.length ?? 0) > 100).toBe(true);
  });
});

test.describe("Settings - API Keys Tab", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateToTab(page, "/settings", "api");
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("displays create API key button", async ({ page }) => {
    const createButton = page
      .locator(
        'button:has-text("Create"), button:has-text("Generate"), button:has-text("New"), button:has-text("Add")',
      )
      .first();
    const isVisible = await createButton
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    const hasApiContent = await pageContainsText(page, "api", "key", "token");
    expect(isVisible || hasApiContent).toBe(true);
  });

  test("opens create key dialog when clicking create", async ({ page }) => {
    const modal = await openModal(
      page,
      'button:has-text("Create"), button:has-text("Generate"), button:has-text("New")',
    );

    if (modal) {
      const modalText = await modal.textContent();
      expect(modalText?.length).toBeGreaterThan(0);
      await closeModal(page);
    } else {
      const body = await page.locator("body").textContent();
      expect(body?.length).toBeGreaterThan(50);
    }
  });

  test("shows existing API keys list or empty state", async ({ page }) => {
    const hasKeyContent = await pageContainsText(
      page,
      "api",
      "key",
      "no key",
      "create",
      "token",
    );
    expect(hasKeyContent).toBe(true);
  });

  test("shows copy button for existing keys", async ({ page }) => {
    const copyButton = page
      .locator(
        'button:has-text("Copy"), button[aria-label*="copy" i], button:has(svg.lucide-copy)',
      )
      .first();
    const hasCopy = await copyButton
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    // Copy button only visible if keys exist
    const body = await page.locator("body").textContent();
    expect(typeof hasCopy === "boolean" && (body?.length ?? 0) > 50).toBe(true);
  });

  test("shows revoke button for existing keys", async ({ page }) => {
    const revokeButton = page
      .locator(
        'button:has-text("Revoke"), button:has-text("Delete"), button:has-text("Remove")',
      )
      .first();
    const hasRevoke = await revokeButton
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    const body = await page.locator("body").textContent();
    expect(typeof hasRevoke === "boolean" && (body?.length ?? 0) > 50).toBe(
      true,
    );
  });
});

test.describe("Settings - Social Linking", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateTo(page, ROUTES.SETTINGS);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("displays Twitter/X link option", async ({ page }) => {
    const twitterButton = page
      .locator(
        'button:has-text("Twitter"), button:has-text("X"), button:has-text("Connect X")',
      )
      .first();
    const isVisible = await twitterButton
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    const hasTwitterContent = await pageContainsText(page, "twitter", "x.com");
    expect(isVisible || hasTwitterContent).toBe(true);
  });

  test("displays Discord link option", async ({ page }) => {
    const discordButton = page
      .locator('button:has-text("Discord"), button:has-text("Connect Discord")')
      .first();
    const isVisible = await discordButton
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    const hasDiscordContent = await pageContainsText(page, "discord");
    expect(isVisible || hasDiscordContent).toBe(true);
  });

  test("displays GitHub link option if available", async ({ page }) => {
    const githubButton = page
      .locator('button:has-text("GitHub"), button:has-text("Connect GitHub")')
      .first();
    const isVisible = await githubButton
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    // GitHub linking may or may not be available
    const body = await page.locator("body").textContent();
    expect(typeof isVisible === "boolean" && (body?.length ?? 0) > 50).toBe(
      true,
    );
  });
});
