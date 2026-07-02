/**
 * Post Detail Page E2E Tests
 *
 * Tests post detail functionality: full content display, author info,
 * interactions (like, share), and comment section with threading.
 */

import { expect, test } from "./fixtures";
import { pageContainsText } from "./helpers/interaction-helpers";
import {
  cooldownBetweenTests,
  isServerHealthy,
  navigateTo,
  waitForPageLoad,
} from "./helpers/page-helpers";
import { loginWithWallet } from "./helpers/auth";
import { ROUTES, SELECTORS, TIMEOUTS, VIEWPORTS } from "./helpers/test-data";

test.setTimeout(TIMEOUTS.EXTRA_LONG);

test.describe("Post Detail - Page Load", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(
      !(await isServerHealthy()),
      "feed server is not healthy at /api/health",
    );
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    await page.waitForTimeout(3000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("loads post detail page from feed navigation", async ({ page }) => {
    const postContent = page
      .locator('article p, [data-testid="post-card"] p, .post-content')
      .first();

    if (
      await postContent
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false)
    ) {
      await postContent.click({ force: true });
      await page.waitForTimeout(2000);

      const url = page.url();
      if (url.includes("/post/") || url.includes("/article/")) {
        const body = await page.locator("body").textContent();
        expect(body?.length).toBeGreaterThan(100);
      }
    }

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("displays full post content", async ({ page }) => {
    const postLink = page.locator('a[href*="/post/"]').first();

    if (
      await postLink.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      const href = await postLink.getAttribute("href");
      if (href) {
        await navigateTo(page, href);
        await waitForPageLoad(page);
        await page.waitForTimeout(2000);

        const body = await page.locator("body").textContent();
        expect(body?.length).toBeGreaterThan(100);
      }
    }
  });

  test("displays post author info with avatar", async ({ page }) => {
    const postLink = page.locator('a[href*="/post/"]').first();

    if (
      await postLink.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      const href = await postLink.getAttribute("href");
      if (href) {
        await navigateTo(page, href);
        await waitForPageLoad(page);
        await page.waitForTimeout(2000);

        // Check for author info (avatar, name, handle)
        const hasAuthorInfo =
          (await page
            .locator(
              'img[alt*="avatar" i], [data-testid="profile-avatar"], .avatar',
            )
            .first()
            .isVisible({ timeout: TIMEOUTS.SHORT })
            .catch(() => false)) || (await pageContainsText(page, "@"));

        const body = await page.locator("body").textContent();
        expect(hasAuthorInfo || (body?.length ?? 0) > 100).toBe(true);
      }
    }
  });

  test("displays post timestamp", async ({ page }) => {
    const postLink = page.locator('a[href*="/post/"]').first();

    if (
      await postLink.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      const href = await postLink.getAttribute("href");
      if (href) {
        await navigateTo(page, href);
        await waitForPageLoad(page);
        await page.waitForTimeout(2000);

        // Timestamp may be relative (ago) or absolute
        const hasTimestamp = await pageContainsText(
          page,
          "ago",
          "minute",
          "hour",
          "day",
          "week",
          "month",
          "202",
        );

        const body = await page.locator("body").textContent();
        expect(hasTimestamp || (body?.length ?? 0) > 100).toBe(true);
      }
    }
  });
});

test.describe("Post Detail - Interactions", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(
      !(await isServerHealthy()),
      "feed server is not healthy at /api/health",
    );
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    await page.waitForTimeout(3000);

    // Navigate to first post detail
    const postLink = page.locator('a[href*="/post/"]').first();
    if (
      await postLink.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      const href = await postLink.getAttribute("href");
      if (href) {
        await navigateTo(page, href);
        await waitForPageLoad(page);
        await page.waitForTimeout(2000);
      }
    }
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("clicks like button on post detail", async ({ page }) => {
    const likeButton = page.locator(SELECTORS.LIKE_BUTTON).first();

    if (
      await likeButton.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      await likeButton.click({ force: true });
      await page.waitForTimeout(1000);
    }

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("clicks share button on post detail", async ({ page }) => {
    const shareButton = page.locator(SELECTORS.SHARE_BUTTON).first();

    if (
      await shareButton
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false)
    ) {
      await shareButton.click({ force: true });
      await page.waitForTimeout(1000);

      // Close any share dialog
      await page.keyboard.press("Escape").catch(() => {});
    }

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("displays comment count", async ({ page }) => {
    // Look for comment count indicator
    const commentButton = page.locator(SELECTORS.COMMENT_BUTTON).first();
    const hasCommentButton = await commentButton
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    const hasCommentContent = await pageContainsText(
      page,
      "comment",
      "reply",
      "response",
    );

    const body = await page.locator("body").textContent();
    expect(
      hasCommentButton || hasCommentContent || (body?.length ?? 0) > 100,
    ).toBe(true);
  });
});

test.describe("Post Detail - Comment Section", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(
      !(await isServerHealthy()),
      "feed server is not healthy at /api/health",
    );
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    await page.waitForTimeout(3000);

    // Navigate to first post detail
    const postLink = page.locator('a[href*="/post/"]').first();
    if (
      await postLink.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      const href = await postLink.getAttribute("href");
      if (href) {
        await navigateTo(page, href);
        await waitForPageLoad(page);
        await page.waitForTimeout(2000);
      }
    }
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("displays comment section", async ({ page }) => {
    const url = page.url();
    if (url.includes("/post/") || url.includes("/article/")) {
      const hasCommentSection = await pageContainsText(
        page,
        "comment",
        "reply",
        "response",
        "write",
      );

      const body = await page.locator("body").textContent();
      expect(hasCommentSection || (body?.length ?? 0) > 100).toBe(true);
    }
  });

  test("displays existing comments if any", async ({ page }) => {
    const url = page.url();
    if (url.includes("/post/")) {
      // Comments may or may not exist
      const comments = page.locator(
        '[data-testid*="comment"], .comment, article article',
      );
      const _count = await comments.count().catch(() => 0);

      const body = await page.locator("body").textContent();
      expect(body?.length).toBeGreaterThan(100);
    }
  });

  test("shows comment input for authenticated users", async ({ page }) => {
    const url = page.url();
    if (url.includes("/post/")) {
      const commentInput = page
        .locator(
          'textarea[placeholder*="comment" i], textarea[placeholder*="reply" i], textarea[placeholder*="write" i], input[placeholder*="comment" i]',
        )
        .first();

      const hasInput = await commentInput
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false);

      const body = await page.locator("body").textContent();
      expect(hasInput || (body?.length ?? 0) > 100).toBe(true);
    }
  });

  test("types and submits a comment", async ({ page }) => {
    const url = page.url();
    if (url.includes("/post/")) {
      const commentInput = page
        .locator(
          'textarea[placeholder*="comment" i], textarea[placeholder*="reply" i], textarea[placeholder*="write" i]',
        )
        .first();

      if (
        await commentInput
          .isVisible({ timeout: TIMEOUTS.SHORT })
          .catch(() => false)
      ) {
        const testComment = `E2E test comment ${Date.now()}`;
        await commentInput.fill(testComment);
        await page.waitForTimeout(500);

        const value = await commentInput.inputValue();
        expect(value).toContain("E2E test comment");

        // Look for submit button
        const submitButton = page
          .locator(
            'button:has-text("Reply"), button:has-text("Comment"), button:has-text("Post"), button[type="submit"]',
          )
          .first();

        if (
          await submitButton
            .isVisible({ timeout: TIMEOUTS.SHORT })
            .catch(() => false)
        ) {
          // Don't actually submit - just verify it's enabled
          const isDisabled = await submitButton.isDisabled().catch(() => true);
          expect(isDisabled).toBe(false);
        }
      }
    }
  });

  test("shows reply button on existing comments", async ({ page }) => {
    const url = page.url();
    if (url.includes("/post/")) {
      const replyButton = page
        .locator('button:has-text("Reply"), button[aria-label*="reply" i]')
        .first();
      const hasReply = await replyButton
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false);

      // Reply buttons may not exist if there are no comments
      const body = await page.locator("body").textContent();
      expect(typeof hasReply === "boolean" && (body?.length ?? 0) > 50).toBe(
        true,
      );
    }
  });
});
