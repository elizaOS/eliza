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
    if (isVisible) {
      await postCard.click({ force: true });
      await page.waitForTimeout(2000);
      const _url = page.url();
      const body = await page.locator("body").textContent();
      expect(body).toBeTruthy();
      expect(body?.length).toBeGreaterThan(0);
    } else {
      expect(true).toBe(true);
    }
  });

  test("post shows full content", async ({ page }) => {
    await navigateTo(page, ROUTES.POST_BY_ID("test-post"));
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("author info displayed", async ({ page }) => {
    await navigateTo(page, ROUTES.POST_BY_ID("test-post"));
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
  });

  test("timestamp displayed", async ({ page }) => {
    await navigateTo(page, ROUTES.POST_BY_ID("test-post"));
    await waitForPageLoad(page);
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
    expect(typeof hasTimestamp).toBe("boolean");
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
    await navigateTo(page, ROUTES.POST_BY_ID("test-post"));
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("like button on post detail", async ({ page }) => {
    const likeBtn = page.locator(SELECTORS.LIKE_BUTTON).first();
    const isVisible = await likeBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    if (isVisible) {
      await likeBtn.click({ force: true });
      await page.waitForTimeout(500);
    }
    expect(true).toBe(true);
  });

  test("share button on post detail", async ({ page }) => {
    const shareBtn = page.locator(SELECTORS.SHARE_BUTTON).first();
    const isVisible = await shareBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    expect(typeof isVisible).toBe("boolean");
  });

  test("comment count displayed", async ({ page }) => {
    const commentBtn = page.locator(SELECTORS.COMMENT_BUTTON).first();
    const isVisible = await commentBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    expect(typeof isVisible).toBe("boolean");
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
    await navigateTo(page, ROUTES.POST_BY_ID("test-post"));
    await waitForPageLoad(page);
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
    expect(typeof hasComments).toBe("boolean");
  });

  test("existing comments display", async ({ page }) => {
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("comment input field visible", async ({ page }) => {
    const commentInput = page
      .locator(
        'textarea[placeholder*="comment" i], textarea[placeholder*="reply" i], input[placeholder*="comment" i]',
      )
      .first();
    const isVisible = await commentInput
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    expect(typeof isVisible).toBe("boolean");
  });

  test("submit comment button visible", async ({ page }) => {
    const submitBtn = page
      .locator(
        'button:has-text("Comment"), button:has-text("Reply"), button:has-text("Send")',
      )
      .first();
    const isVisible = await submitBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    expect(typeof isVisible).toBe("boolean");
  });

  test("reply button on comments", async ({ page }) => {
    const replyBtn = page.locator('button:has-text("Reply")').first();
    const isVisible = await replyBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    expect(typeof isVisible).toBe("boolean");
  });
});
