import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { pageContainsText } from "./helpers/interaction-helpers";
import {
  cooldownBetweenTests,
  isServerHealthy,
  navigateTo,
  waitForPageLoad,
} from "./helpers/page-helpers";
import { ROUTES, SELECTORS, VIEWPORTS } from "./helpers/test-data";
import { loginWithWallet } from "./helpers/wallet-auth";

test.setTimeout(60000);

/**
 * Open the first real post's detail page by clicking through from the feed.
 * (There is no fixture post id — a made-up id would land on a 404 page and
 * every assertion against it would be meaningless.)
 * Returns false when the feed renders no posts.
 */
async function openFirstPostDetail(page: Page): Promise<boolean> {
  await navigateTo(page, ROUTES.FEED);
  await waitForPageLoad(page);
  const postCard = page.locator(SELECTORS.POST_CARD).first();
  if (!(await postCard.isVisible({ timeout: 5000 }).catch(() => false))) {
    return false;
  }
  await postCard.click({ force: true });
  await page.waitForTimeout(2000);
  return true;
}

test.describe("Post Detail - Load", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("navigate to post detail from feed", async ({ page }) => {
    const postCard = page.locator(SELECTORS.POST_CARD).first();
    const isVisible = await postCard
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no post cards rendered in the feed");
    const beforeUrl = page.url();
    await postCard.click({ force: true });
    await page.waitForTimeout(2000);
    expect(page.url()).not.toBe(beforeUrl);
  });

  test("post shows full content", async ({ page }) => {
    const opened = await openFirstPostDetail(page);
    test.skip(!opened, "no post cards rendered in the feed");
    const post = page.locator(`article, ${SELECTORS.POST_CARD}`).first();
    await expect(post).toBeVisible({ timeout: 5000 });
  });

  test("author info displayed", async ({ page }) => {
    const opened = await openFirstPostDetail(page);
    test.skip(!opened, "no post cards rendered in the feed");
    const authorLink = page
      .locator('a[href*="/profile"], a[href*="/u/"]')
      .first();
    await expect(authorLink).toBeVisible({ timeout: 5000 });
  });

  test("timestamp displayed", async ({ page }) => {
    const opened = await openFirstPostDetail(page);
    test.skip(!opened, "no post cards rendered in the feed");
    const hasTimestamp = await pageContainsText(
      page,
      "ago",
      "today",
      "yesterday",
      "am",
      "pm",
      "2024",
      "2025",
      "2026",
    );
    expect(hasTimestamp).toBe(true);
  });
});

test.describe("Post Detail - Interactions", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    const opened = await openFirstPostDetail(page);
    test.skip(!opened, "no post cards rendered in the feed");
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("like button on post detail", async ({ page }) => {
    const likeBtn = page.locator(SELECTORS.LIKE_BUTTON).first();
    const isVisible = await likeBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no like button rendered on the post detail page");
    // A real like click must hit the like API (/api/posts/[id]/like).
    const likeResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/like") &&
        response.request().method() !== "GET",
      { timeout: 10_000 },
    );
    await likeBtn.click({ force: true });
    const response = await likeResponse;
    expect(response.status()).toBeLessThan(500);
  });

  test("share button on post detail", async ({ page }) => {
    const shareBtn = page.locator(SELECTORS.SHARE_BUTTON).first();
    await expect(shareBtn).toBeVisible({ timeout: 5000 });
  });

  test("comment count displayed", async ({ page }) => {
    const commentBtn = page.locator(SELECTORS.COMMENT_BUTTON).first();
    await expect(commentBtn).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Post Detail - Comments", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    const opened = await openFirstPostDetail(page);
    test.skip(!opened, "no post cards rendered in the feed");
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("comment section visible", async ({ page }) => {
    const hasComments = await pageContainsText(
      page,
      "comment",
      "reply",
      "response",
    );
    expect(hasComments).toBe(true);
  });

  test("comment input field visible", async ({ page }) => {
    const commentInput = page
      .locator(
        'textarea[placeholder*="comment" i], textarea[placeholder*="reply" i], input[placeholder*="comment" i]',
      )
      .first();
    await expect(commentInput).toBeVisible({ timeout: 5000 });
  });

  test("submit comment button visible", async ({ page }) => {
    const submitBtn = page
      .locator(
        'button:has-text("Comment"), button:has-text("Reply"), button:has-text("Send")',
      )
      .first();
    await expect(submitBtn).toBeVisible({ timeout: 5000 });
  });

  test("reply button on comments", async ({ page }) => {
    // Reply affordances exist only when the post already has comments.
    const comment = page
      .locator('[data-testid*="comment"], .comment')
      .first();
    const hasComments = await comment
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!hasComments, "post has no comments in this seed");
    const replyBtn = page.locator('button:has-text("Reply")').first();
    await expect(replyBtn).toBeVisible({ timeout: 5000 });
  });
});
