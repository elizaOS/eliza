/**
 * Playwright e2e coverage driving a real MetaMask wallet (@avalix/chroma + Privy) against a live Feed dev server; every spec skips when the /api/health check fails.
 *
 * Covers the profile pages (own profile and other users) and their tabs.
 */
import { expect, test } from "./fixtures";
import { clickTab, pageContainsText } from "./helpers/interaction-helpers";
import {
  cooldownBetweenTests,
  isServerHealthy,
  navigateTo,
  waitForPageLoad,
} from "./helpers/page-helpers";
import { ROUTES, SELECTORS, VIEWPORTS } from "./helpers/test-data";
import { loginWithWallet } from "./helpers/wallet-auth";

test.setTimeout(60000);

test.describe("Profile - Own Profile", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.PROFILE);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("profile page displays user info", async ({ page }) => {
    const hasContent = await pageContainsText(
      page,
      "profile",
      "wallet",
      "address",
      "user",
    );
    expect(hasContent).toBe(true);
  });

  test("no follow button on own profile", async ({ page }) => {
    const followBtn = page.locator(SELECTORS.FOLLOW_BUTTON).first();
    const isVisible = await followBtn
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    expect(isVisible).toBe(false);
  });

  test("wallet address displayed", async ({ page }) => {
    const hasWallet = await pageContainsText(page, "0x", "wallet");
    expect(hasWallet).toBe(true);
  });

  test("profile stats visible", async ({ page }) => {
    // ProfilePageClient always renders the Followers / Following stat rows.
    const hasStats = await pageContainsText(page, "followers", "following");
    expect(hasStats).toBe(true);
  });
});

test.describe("Profile - Content Tabs", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.PROFILE);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  // ProfilePageClient renders exactly three content tabs: Posts, Replies,
  // Trades. Each must be clickable; a missing tab is a regression.
  test("Posts tab visible", async ({ page }) => {
    const switched = await clickTab(page, "Posts");
    expect(switched).toBe(true);
  });

  test("Replies tab visible", async ({ page }) => {
    const switched = await clickTab(page, "Replies");
    expect(switched).toBe(true);
  });

  test("Trades tab visible", async ({ page }) => {
    const switched = await clickTab(page, "Trades");
    expect(switched).toBe(true);
  });
});

test.describe("Profile - Other User", () => {
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

  test("navigate to other user from feed", async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    const authorLink = page
      .locator(
        `${SELECTORS.POST_CARD} a[href*="profile"], ${SELECTORS.POST_CARD} a[href*="/u/"]`,
      )
      .first();
    const isVisible = await authorLink
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no author profile links rendered in the feed");
    const beforeUrl = page.url();
    await authorLink.click({ force: true });
    await page.waitForTimeout(2000);
    expect(page.url()).not.toBe(beforeUrl);
  });

  test("follow/unfollow button on other user profile", async ({ page }) => {
    await navigateTo(page, ROUTES.PROFILE_BY_ID("test-user"));
    await waitForPageLoad(page);
    const followBtn = page.locator(SELECTORS.FOLLOW_BUTTON).first();
    const isVisible = await followBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(
      !isVisible,
      "no follow button rendered (user 'test-user' may not exist in this seed)",
    );
    await expect(followBtn).toBeEnabled();
  });

  test("message button navigates to DM", async ({ page }) => {
    await navigateTo(page, ROUTES.PROFILE_BY_ID("test-user"));
    await waitForPageLoad(page);
    const messageBtn = page.locator(SELECTORS.MESSAGE_BUTTON).first();
    const isVisible = await messageBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no message button rendered on the profile page");
    await messageBtn.click({ force: true });
    await page.waitForTimeout(2000);
    const url = page.url();
    const hasChatContent = await pageContainsText(
      page,
      "message",
      "chat",
      "send",
    );
    expect(url.includes("chat") || hasChatContent).toBe(true);
  });

  test("handle route /u/[handle] loads", async ({ page }) => {
    await navigateTo(page, ROUTES.USER_BY_HANDLE("testuser"));
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });
});
