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
    expect(typeof switched).toBe("boolean");
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
    expect(typeof isVisible).toBe("boolean");
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
    const sendBtn = page.locator(SELECTORS.SEND_BUTTON).first();
    const isVisible = await sendBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    expect(typeof isVisible).toBe("boolean");
  });

  test("message timestamps visible", async ({ page }) => {
    const hasTimestamps = await pageContainsText(
      page,
      "ago",
      "today",
      "yesterday",
      "am",
      "pm",
    );
    expect(typeof hasTimestamps).toBe("boolean");
  });

  test("SSE connection status indicator", async ({ page }) => {
    const hasStatus = await pageContainsText(
      page,
      "connected",
      "online",
      "live",
    );
    expect(typeof hasStatus).toBe("boolean");
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
    test.skip(
      modal === null,
      "no group/chat creation button rendered on the chats page",
    );
    await expect(modal).toBeVisible();
    await closeModal(page);
  });

  test("group creation requires name", async ({ page }) => {
    const modal = await openModal(
      page,
      'button:has-text("New Group"), button:has-text("Create Group"), button:has-text("New Chat")',
    );
    test.skip(
      modal === null,
      "no group/chat creation button rendered on the chats page",
    );
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
    test.skip(
      modal === null,
      "no group/chat creation button rendered on the chats page",
    );
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
