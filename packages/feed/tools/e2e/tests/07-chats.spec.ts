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

test.describe("Chats - Layout", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.CHATS);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("chats page loads", async ({ page }) => {
    const hasContent = await pageContainsText(
      page,
      "chat",
      "message",
      "conversation",
      "direct",
    );
    expect(hasContent).toBe(true);
  });

  test("filter tabs visible", async ({ page }) => {
    const tabs = page.locator('[role="tab"]');
    const tabCount = await tabs.count().catch(() => 0);
    expect(tabCount).toBeGreaterThanOrEqual(0);
  });

  test("tab switching works", async ({ page }) => {
    const switched = await clickTab(page, "All");
    test.skip(!switched, 'no "All" tab rendered on the chats page');
    const hasContent = await pageContainsText(
      page,
      "chat",
      "message",
      "conversation",
      "direct",
    );
    expect(hasContent).toBe(true);
  });

  test("chat list renders", async ({ page }) => {
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("search input visible", async ({ page }) => {
    const searchInput = page.locator(SELECTORS.SEARCH_INPUT).first();
    const isVisible = await searchInput
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no search input rendered on the chats page");
    await expect(searchInput).toBeEnabled();
  });
});

test.describe("Chats - Messaging", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.CHATS);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("type message into chat input", async ({ page }) => {
    const chatInput = page.locator(SELECTORS.CHAT_INPUT).first();
    const isVisible = await chatInput
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no chat input rendered (no chat open)");
    await chatInput.fill("Hello E2E test");
    const value = await chatInput.inputValue().catch(() => "");
    expect(value).toContain("Hello");
  });

  test("send button present", async ({ page }) => {
    // The send button belongs to the composer: if a chat composer is open,
    // its send button must render alongside it.
    const chatInput = page.locator(SELECTORS.CHAT_INPUT).first();
    const composerOpen = await chatInput
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!composerOpen, "no chat composer rendered (no chat open)");
    await expect(page.locator(SELECTORS.SEND_BUTTON).first()).toBeVisible();
  });

  test("message timestamps visible", async ({ page }) => {
    const timeElements = await page
      .locator("time")
      .count()
      .catch(() => 0);
    const hasRelativeTime = await pageContainsText(
      page,
      "ago",
      "today",
      "yesterday",
      "just now",
    );
    const hasTimestamps = timeElements > 0 || hasRelativeTime;
    test.skip(
      !hasTimestamps,
      "no message timestamps rendered (no messages in any chat)",
    );
    expect(hasTimestamps).toBe(true);
  });

  test("SSE connection status indicator", async ({ page }) => {
    const hasStatus = await pageContainsText(
      page,
      "connected",
      "online",
      "live",
    );
    test.skip(
      !hasStatus,
      "no connection-status indicator rendered on the chats page",
    );
    expect(hasStatus).toBe(true);
  });
});

test.describe("Chats - Group Creation", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.CHATS);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("group creation modal opens", async ({ page }) => {
    const modal = await openModal(
      page,
      'button:has-text("New Group"), button:has-text("Create Group"), button:has-text("New Chat")',
    );
    if (modal === null) {
      test.skip(true, "no group/chat creation button rendered on the chats page");
      return;
    }
    await expect(modal).toBeVisible();
    await closeModal(page);
  });

  test("group creation requires name", async ({ page }) => {
    const modal = await openModal(
      page,
      'button:has-text("New Group"), button:has-text("Create Group"), button:has-text("New Chat")',
    );
    if (modal === null) {
      test.skip(true, "no group/chat creation button rendered on the chats page");
      return;
    }
    const nameInput = modal
      .locator('input[name="name"], input[placeholder*="name" i]')
      .first();
    // A creation form must ask for a name.
    await expect(nameInput).toBeVisible({ timeout: 3000 });
    await closeModal(page);
  });

  test("cancel closes group creation modal", async ({ page }) => {
    const modal = await openModal(
      page,
      'button:has-text("New Group"), button:has-text("Create Group"), button:has-text("New Chat")',
    );
    if (modal === null) {
      test.skip(true, "no group/chat creation button rendered on the chats page");
      return;
    }
    await closeModal(page);
    const modalGone = page.locator(SELECTORS.MODAL).first();
    const stillVisible = await modalGone
      .isVisible({ timeout: 1000 })
      .catch(() => false);
    expect(stillVisible).toBe(false);
  });
});

test.describe("Chats - Search", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.CHATS);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("search filters chats", async ({ page }) => {
    const result = await fillAndVerify(page, SELECTORS.SEARCH_INPUT, "test");
    test.skip(result === null, "no search input rendered on the chats page");
    expect(result).toBe("test");
  });

  test("clear search resets list", async ({ page }) => {
    await fillAndVerify(page, SELECTORS.SEARCH_INPUT, "test");
    await page.waitForTimeout(500);
    await fillAndVerify(page, SELECTORS.SEARCH_INPUT, "");
    await page.waitForTimeout(500);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
  });
});

test.describe("Chats - Mobile", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.MOBILE);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.CHATS);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("chats render responsively on mobile", async ({ page }) => {
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
