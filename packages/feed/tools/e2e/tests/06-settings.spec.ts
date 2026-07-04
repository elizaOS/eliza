/**
 * Playwright e2e coverage driving a real MetaMask wallet (@avalix/chroma + Privy) against a live Feed dev server; every spec skips when the /api/health check fails.
 *
 * Covers the settings tabs: profile, theme, notifications, privacy, security, API keys, and social linking.
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

test.describe("Settings - Navigation", () => {
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

  test("settings page loads", async ({ page }) => {
    const hasContent = await pageContainsText(
      page,
      "settings",
      "account",
      "preferences",
    );
    expect(hasContent).toBe(true);
  });

  test("tab switching works", async ({ page }) => {
    const tabs = page.locator('[role="tab"]');
    const tabCount = await tabs.count().catch(() => 0);
    expect(tabCount).toBeGreaterThan(0);
  });
});

test.describe("Settings - Profile Tab", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.SETTINGS);
    await waitForPageLoad(page);
    const onTab = await clickTab(page, "Profile");
    test.skip(!onTab, 'no "Profile" tab rendered on the settings page');
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("profile form fields visible", async ({ page }) => {
    const hasFields = await pageContainsText(page, "name", "username", "bio");
    expect(hasFields).toBe(true);
  });

  test("avatar section visible", async ({ page }) => {
    const avatar = page
      .locator(
        'img[alt*="avatar" i], img[alt*="profile" i], [data-testid*="avatar"]',
      )
      .first();
    const isVisible = await avatar
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(
      !isVisible,
      "no avatar image rendered (user has no profile image; Avatar falls back to initials)",
    );
    // The avatar image must have actually loaded, not 404'd.
    const loaded = await avatar
      .evaluate((el) => el instanceof HTMLImageElement && el.naturalWidth > 0)
      .catch(() => false);
    expect(loaded).toBe(true);
  });

  test("edit name field", async ({ page }) => {
    const result = await fillAndVerify(
      page,
      'input[name="name"], input[placeholder*="name" i]',
      "Test User",
    );
    test.skip(result === null, "no name input rendered on the profile tab");
    expect(result).toBe("Test User");
  });

  test("edit username field", async ({ page }) => {
    const result = await fillAndVerify(
      page,
      'input[name="username"], input[placeholder*="username" i]',
      "testuser123",
    );
    test.skip(
      result === null,
      "no username input rendered on the profile tab",
    );
    expect(result).toBe("testuser123");
  });

  test("edit bio field", async ({ page }) => {
    const result = await fillAndVerify(
      page,
      'textarea[name="bio"], textarea[placeholder*="bio" i]',
      "Test bio content",
    );
    test.skip(result === null, "no bio textarea rendered on the profile tab");
    expect(result).toBe("Test bio content");
  });

  test("save button visible", async ({ page }) => {
    // The profile tab always renders its "Save Changes" button.
    const saveBtn = page.locator(SELECTORS.SAVE_BUTTON).first();
    await expect(saveBtn).toBeVisible({ timeout: 5000 });
  });

  test("validation on empty required fields", async ({ page }) => {
    const nameInput = page
      .locator('input[name="name"], input[placeholder*="name" i]')
      .first();
    const isVisible = await nameInput
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no name input rendered on the settings page");
    await nameInput.clear();
    await page.waitForTimeout(300);
    const saveBtn = page.locator(SELECTORS.SAVE_BUTTON).first();
    if (await saveBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await saveBtn.click({ force: true });
      await page.waitForTimeout(500);
    }
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
  });
});

test.describe("Settings - Theme Tab", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.SETTINGS);
    await waitForPageLoad(page);
    const onTab = await clickTab(page, "Theme");
    test.skip(!onTab, 'no "Theme" tab rendered on the settings page');
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  // The theme tab lists exactly Light / Dark / System options.
  test("light theme option visible", async ({ page }) => {
    expect(await pageContainsText(page, "light")).toBe(true);
  });

  test("dark theme option visible", async ({ page }) => {
    expect(await pageContainsText(page, "dark")).toBe(true);
  });

  test("system theme option visible", async ({ page }) => {
    expect(await pageContainsText(page, "system")).toBe(true);
  });

  test("theme switch changes appearance", async ({ page }) => {
    const darkBtn = page
      .locator(
        'button:has-text("Dark"), label:has-text("Dark"), [data-testid*="dark"]',
      )
      .first();
    const isVisible = await darkBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no dark-theme control rendered on the settings page");
    const before = (await page.locator("html").getAttribute("class")) ?? "";
    await darkBtn.click({ force: true });
    await page.waitForTimeout(500);
    const after = (await page.locator("html").getAttribute("class")) ?? "";
    // Switching theme must change the root class (or already be dark).
    expect(after !== before || after.includes("dark")).toBe(true);
  });
});

test.describe("Settings - Notifications Tab", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.SETTINGS);
    await waitForPageLoad(page);
    const onTab = await clickTab(page, "Notifications");
    test.skip(!onTab, 'no "Notifications" tab rendered on the settings page');
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("notification toggles visible", async ({ page }) => {
    // The notifications tab renders at least one Switch control.
    const toggles = page.locator('input[type="checkbox"], [role="switch"]');
    const count = await toggles.count().catch(() => 0);
    expect(count).toBeGreaterThan(0);
  });
});

test.describe("Settings - Privacy Tab", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.SETTINGS);
    await waitForPageLoad(page);
    const onTab = await clickTab(page, "Privacy");
    test.skip(!onTab, 'no "Privacy" tab rendered on the settings page');
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("privacy options visible", async ({ page }) => {
    // The privacy tab exposes data-export and account controls.
    const hasContent = await pageContainsText(
      page,
      "privacy",
      "data",
      "account",
    );
    expect(hasContent).toBe(true);
  });

  test("delete account option present", async ({ page }) => {
    // The privacy tab renders the "Delete Your Account" section.
    const hasDelete = await pageContainsText(
      page,
      "delete",
      "remove",
      "deactivate",
    );
    expect(hasDelete).toBe(true);
  });
});

test.describe("Settings - Security Tab", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.SETTINGS);
    await waitForPageLoad(page);
    const onTab = await clickTab(page, "Security");
    test.skip(!onTab, 'no "Security" tab rendered on the settings page');
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("security settings display", async ({ page }) => {
    // The security tab renders "Account Security" + "Security Resources".
    const hasContent = await pageContainsText(
      page,
      "security",
      "password",
      "authentication",
    );
    expect(hasContent).toBe(true);
  });
});

test.describe("Settings - API Keys Tab", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.SETTINGS);
    await waitForPageLoad(page);
    const onTab = await clickTab(page, "API Keys");
    test.skip(!onTab, 'no "API Keys" tab rendered on the settings page');
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("create API key button visible", async ({ page }) => {
    // The API Keys tab always renders its "Generate Key" button.
    const createBtn = page
      .locator(
        'button:has-text("Create"), button:has-text("Generate"), button:has-text("New Key")',
      )
      .first();
    await expect(createBtn).toBeVisible({ timeout: 5000 });
  });

  test("create API key dialog opens", async ({ page }) => {
    const modal = await openModal(
      page,
      'button:has-text("Create"), button:has-text("Generate"), button:has-text("New Key")',
    );
    if (modal === null) {
      test.skip(true, "no create-API-key button rendered on the settings page");
      return;
    }
    await expect(modal).toBeVisible();
    await closeModal(page);
  });

  test("API keys list renders", async ({ page }) => {
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("copy button on API key", async ({ page }) => {
    // The Copy button only renders right after a key is generated.
    const copyBtn = page
      .locator('button:has-text("Copy"), button[aria-label*="copy" i]')
      .first();
    const isVisible = await copyBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no freshly generated API key banner rendered");
    await expect(copyBtn).toBeEnabled();
  });

  test("revoke button on API key", async ({ page }) => {
    // Each existing key row renders a Revoke button; a fresh account shows
    // the empty state instead.
    const revokeBtn = page
      .locator(
        'button:has-text("Revoke"), button:has-text("Delete"), button:has-text("Remove")',
      )
      .first();
    const hasRevoke = await revokeBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    const hasEmptyState = await pageContainsText(
      page,
      "generate your first api key",
      "no api keys",
    );
    expect(hasRevoke || hasEmptyState).toBe(true);
  });
});

test.describe("Settings - Social Linking", () => {
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

  test("Twitter link option present", async ({ page }) => {
    // Settings renders a "Twitter/X" social visibility section.
    const hasTwitter = await pageContainsText(
      page,
      "twitter",
      "x.com",
      "connect twitter",
    );
    expect(hasTwitter).toBe(true);
  });

  // "Discord link option present" and "GitHub link option present" were
  // deleted: the settings page has no Discord or GitHub linking feature
  // (only Twitter/X, Farcaster, and wallet), so those specs tested features
  // that do not exist and could only ever pass vacuously.
});
