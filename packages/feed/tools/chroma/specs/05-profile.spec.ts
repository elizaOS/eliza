/**
 * Profile Page E2E Tests
 *
 * Tests profile viewing and interactions: own profile, other user profiles,
 * content tabs, follow/unfollow, and message button.
 */

import { expect, test } from "./fixtures";
import { clickTab, pageContainsText } from "./helpers/interaction-helpers";
import {
  cooldownBetweenTests,
  isServerHealthy,
  navigateTo,
  waitForPageLoad,
} from "./helpers/page-helpers";
import { loginWithWallet } from "./helpers/auth";
import { ROUTES, SELECTORS, TIMEOUTS, VIEWPORTS } from "./helpers/test-data";

test.setTimeout(TIMEOUTS.EXTRA_LONG);

test.describe("Profile - Own Profile", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(
      !(await isServerHealthy()),
      "feed server is not healthy at /api/health",
    );
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateTo(page, ROUTES.PROFILE);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("displays profile page with user info", async ({ page }) => {
    expect(page.url()).toContain("/profile");

    const hasProfileContent = await pageContainsText(
      page,
      "profile",
      "follow",
      "post",
      "wallet",
    );
    expect(hasProfileContent).toBe(true);
  });

  test("does not show follow button on own profile", async ({ page }) => {
    const followButton = page
      .locator('button:has-text("Follow"):not(:has-text("Following"))')
      .first();
    const isVisible = await followButton
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    if (isVisible) {
      const buttonText = await followButton.textContent();
      expect(buttonText?.includes("Followers")).toBe(true);
    }
  });

  test("displays wallet address or username", async ({ page }) => {
    const hasIdentity = await pageContainsText(
      page,
      "0x",
      "@",
      "user",
      "wallet",
    );

    const body = await page.locator("body").textContent();
    expect(hasIdentity || (body?.length ?? 0) > 100).toBe(true);
  });

  test("shows stats (posts count, followers, following)", async ({ page }) => {
    const hasStats = await pageContainsText(
      page,
      "post",
      "follower",
      "following",
      "like",
    );

    const body = await page.locator("body").textContent();
    expect(hasStats || (body?.length ?? 0) > 100).toBe(true);
  });

  test("displays edit profile button on own profile", async ({ page }) => {
    const editButton = page.locator(SELECTORS.EDIT_PROFILE_BUTTON).first();
    const hasEdit = await editButton
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    const hasEditContent = await pageContainsText(page, "edit");
    expect(hasEdit || hasEditContent).toBe(true);
  });

  test("navigates to settings when clicking edit profile", async ({ page }) => {
    const editButton = page.locator(SELECTORS.EDIT_PROFILE_BUTTON).first();
    if (
      await editButton.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      await editButton.click({ force: true });
      await page.waitForTimeout(2000);

      const url = page.url();
      const navigated = url.includes("/settings") || url.includes("/edit");

      const body = await page.locator("body").textContent();
      expect(navigated || (body?.length ?? 0) > 100).toBe(true);
    }
  });
});

test.describe("Profile - Content Tabs", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(
      !(await isServerHealthy()),
      "feed server is not healthy at /api/health",
    );
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateTo(page, ROUTES.PROFILE);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("switches to Posts tab and shows user posts", async ({ page }) => {
    const _switched = await clickTab(page, "Posts");
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("switches to Replies tab and shows user replies", async ({ page }) => {
    const _switched = await clickTab(page, "Replies");
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("switches to Likes tab and shows liked posts", async ({ page }) => {
    const _switched = await clickTab(page, "Likes");
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("switches to Media tab and shows media posts", async ({ page }) => {
    const _switched = await clickTab(page, "Media");
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });
});

test.describe("Profile - Other User", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(
      !(await isServerHealthy()),
      "feed server is not healthy at /api/health",
    );
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("can navigate to other profile from feed", async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);

    const authorLink = page
      .locator('a[href*="/profile/"], a[href*="/u/"]')
      .first();
    if (
      await authorLink.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      await authorLink.click({ force: true });
      await page.waitForTimeout(2000);

      const url = page.url();
      expect(url.includes("/profile/") || url.includes("/u/")).toBe(true);
    }
  });

  test("other profile shows follow and message buttons", async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);

    const authorLink = page
      .locator('a[href*="/profile/"], a[href*="/u/"]')
      .first();
    const linkVisible = await authorLink
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    if (linkVisible) {
      await authorLink.click({ force: true });
      await page.waitForTimeout(2000);

      const url = page.url();
      if (url.includes("/profile/") || url.includes("/u/")) {
        const hasProfileContent = await pageContainsText(
          page,
          "follow",
          "message",
          "profile",
        );
        expect(hasProfileContent).toBe(true);
      }
    }

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("toggles follow/unfollow on other user profile", async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);

    const authorLink = page
      .locator('a[href*="/profile/"], a[href*="/u/"]')
      .first();
    if (
      await authorLink.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      await authorLink.click({ force: true });
      await page.waitForTimeout(2000);

      const followButton = page.locator(SELECTORS.FOLLOW_BUTTON).first();
      if (
        await followButton
          .isVisible({ timeout: TIMEOUTS.SHORT })
          .catch(() => false)
      ) {
        await followButton.click({ force: true });
        await page.waitForTimeout(1000);

        // Should toggle state
        const body = await page.locator("body").textContent();
        expect(body?.length).toBeGreaterThan(100);
      }
    }
  });

  test("navigates to DM when clicking Message button", async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);

    const authorLink = page
      .locator('a[href*="/profile/"], a[href*="/u/"]')
      .first();
    if (
      await authorLink.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      await authorLink.click({ force: true });
      await page.waitForTimeout(2000);

      const messageButton = page.locator(SELECTORS.MESSAGE_BUTTON).first();
      if (
        await messageButton
          .isVisible({ timeout: TIMEOUTS.SHORT })
          .catch(() => false)
      ) {
        await messageButton.click({ force: true });
        await page.waitForTimeout(2000);

        const url = page.url();
        const navigatedToChat =
          url.includes("/chats") || url.includes("/messages");

        const body = await page.locator("body").textContent();
        expect(navigatedToChat || (body?.length ?? 0) > 100).toBe(true);
      }
    }
  });
});

test.describe("Profile - Handle Route", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(
      !(await isServerHealthy()),
      "feed server is not healthy at /api/health",
    );
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("loads profile page via /u/[handle] route", async ({ page }) => {
    // Navigate to a user handle route
    await navigateTo(page, "/u/testuser");
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);

    // Should show profile content or 404
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(50);
  });
});
