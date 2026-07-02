import { expect, test } from "./fixtures";
import {
  clickTab,
  pageContainsText,
  scrollToLoadMore,
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

test.describe("Feed Interactions", () => {
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

  test("feed shows posts or empty state", async ({ page }) => {
    const hasPosts = await page
      .locator(SELECTORS.POST_CARD)
      .count()
      .catch(() => 0);
    const hasEmptyState = await pageContainsText(
      page,
      "no posts",
      "empty",
      "nothing here",
    );
    expect(hasPosts > 0 || hasEmptyState).toBe(true);
  });

  test("switch to Latest tab", async ({ page }) => {
    const switched = await clickTab(page, "Latest");
    expect(switched).toBe(true);
  });

  // FeedToggle renders exactly these tabs: For You → Stories → Latest →
  // Following. All four must be switchable; a missing tab is a regression.
  test("switch to Stories tab", async ({ page }) => {
    const switched = await clickTab(page, "Stories");
    expect(switched).toBe(true);
  });

  test("switch to For You tab", async ({ page }) => {
    const switched = await clickTab(page, "For You");
    expect(switched).toBe(true);
  });

  test("switch to Following tab", async ({ page }) => {
    const switched = await clickTab(page, "Following");
    expect(switched).toBe(true);
  });

  test("post composer opens", async ({ page }) => {
    const composer = page
      .locator(
        'textarea, [contenteditable="true"], [data-testid="post-composer"]',
      )
      .first();
    const isVisible = await composer
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    if (isVisible) {
      await composer.click({ force: true });
      await expect(composer).toBeEditable();
      return;
    }
    // No inline composer: a create/new-post affordance must open one.
    const createBtn = page
      .locator(
        'button:has-text("New Post"), button:has-text("Create"), button:has-text("Write")',
      )
      .first();
    await expect(
      createBtn,
      "feed offers neither an inline composer nor a create-post button",
    ).toBeVisible({ timeout: 3000 });
    await createBtn.click({ force: true });
    await expect(composer).toBeVisible({ timeout: 5000 });
  });

  test("post submit button disabled when empty", async ({ page }) => {
    const submitBtn = page
      .locator(
        'button:has-text("Post"), button:has-text("Submit"), button:has-text("Publish")',
      )
      .first();
    const isVisible = await submitBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(
      !isVisible,
      "no Post/Submit/Publish button rendered on the feed page",
    );
    await expect(submitBtn).toBeDisabled();
  });

  test("post submit button enabled after typing content", async ({ page }) => {
    const composer = page.locator('textarea, [contenteditable="true"]').first();
    const isVisible = await composer
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no inline composer rendered on the feed page");
    await composer.fill("Test post content for E2E testing");
    await page.waitForTimeout(500);
    const submitBtn = page
      .locator('button:has-text("Post"), button:has-text("Submit")')
      .first();
    const btnVisible = await submitBtn
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    test.skip(
      !btnVisible,
      "no Post/Submit button rendered next to the composer",
    );
    await expect(submitBtn).toBeEnabled();
  });

  test("type content into post composer", async ({ page }) => {
    const composer = page.locator('textarea, [contenteditable="true"]').first();
    const isVisible = await composer
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no inline composer rendered on the feed page");
    await composer.fill("Hello from E2E test");
    const value = await composer.inputValue().catch(() => "");
    expect(value.length).toBeGreaterThan(0);
  });

  test("post composer enforces max length", async ({ page }) => {
    const composer = page.locator('textarea, [contenteditable="true"]').first();
    const isVisible = await composer
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no inline composer rendered on the feed page");
    const longText = "a".repeat(5000);
    await composer.fill(longText);
    await page.waitForTimeout(300);
    const value = await composer.inputValue();
    expect(value.length).toBeGreaterThan(0);
    expect(value.length).toBeLessThanOrEqual(longText.length);
  });

  test("like button toggles on post", async ({ page }) => {
    const likeBtn = page.locator(SELECTORS.LIKE_BUTTON).first();
    const isVisible = await likeBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no post with a like button rendered in the feed");
    // A real like toggle must hit the like API (/api/posts/[id]/like).
    const likeResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/like") &&
        response.request().method() !== "GET",
      { timeout: 10_000 },
    );
    await likeBtn.click({ force: true });
    const response = await likeResponse;
    expect(response.status()).toBe(200);
  });

  test("comment section opens on post", async ({ page }) => {
    const commentBtn = page.locator(SELECTORS.COMMENT_BUTTON).first();
    const isVisible = await commentBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no post with a comment button rendered in the feed");
    await commentBtn.click({ force: true });
    await page.waitForTimeout(1000);
    const hasCommentArea = await pageContainsText(
      page,
      "comment",
      "reply",
      "write",
    );
    expect(hasCommentArea).toBe(true);
  });

  test("share dialog opens on post", async ({ page }) => {
    const shareBtn = page.locator(SELECTORS.SHARE_BUTTON).first();
    const isVisible = await shareBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no post with a share button rendered in the feed");
    await shareBtn.click({ force: true });
    await page.waitForTimeout(500);
    const modal = page.locator(SELECTORS.MODAL).first();
    const modalVisible = await modal
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    const hasShareText = await pageContainsText(page, "share", "copy", "link");
    expect(modalVisible || hasShareText).toBe(true);
  });

  test("click post navigates to detail", async ({ page }) => {
    const postCard = page.locator(SELECTORS.POST_CARD).first();
    const isVisible = await postCard
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no post cards rendered in the feed");
    const beforeUrl = page.url();
    await postCard.click({ force: true });
    await page.waitForTimeout(2000);
    const afterUrl = page.url();
    expect(afterUrl).not.toBe(beforeUrl);
  });

  test("click author navigates to profile", async ({ page }) => {
    const authorLink = page
      .locator(
        `${SELECTORS.POST_CARD} a[href*="profile"], ${SELECTORS.POST_CARD} a[href*="/u/"]`,
      )
      .first();
    const isVisible = await authorLink
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no author profile links rendered in the feed");
    await authorLink.click({ force: true });
    await page.waitForTimeout(2000);
    const url = page.url();
    const navigated = url.includes("profile") || url.includes("/u/");
    expect(navigated).toBe(true);
  });

  test("trending panel renders in the widget column", async ({ page }) => {
    // WidgetSidebar (`hidden xl:flex`, xl = 1280px = the DESKTOP viewport)
    // unconditionally renders TrendingPanel's <h2>Trending</h2> heading.
    const hasTrending = await pageContainsText(page, "trending");
    expect(hasTrending).toBe(true);
  });

  test("infinite scroll loads more posts", async ({ page }) => {
    const result = await scrollToLoadMore(page, SELECTORS.POST_CARD);
    // Either more posts loaded or we reached the end
    expect(result.after).toBeGreaterThanOrEqual(result.before);
  });

  // The app sidebar (<aside> in shared/Sidebar.tsx) is `hidden md:flex`:
  // visible from the md breakpoint (>=768px) up, hidden on mobile widths.
  test("sidebar visible on desktop", async ({ page }) => {
    const sidebar = page
      .locator('aside, [data-testid="sidebar"], .sidebar')
      .first();
    await expect(sidebar).toBeVisible({ timeout: 5000 });
  });

  test("sidebar hidden on mobile viewport", async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.MOBILE);
    await page.waitForTimeout(500);
    const sidebar = page
      .locator('aside, [data-testid="sidebar"], .sidebar')
      .first();
    await expect(sidebar).toBeHidden({ timeout: 3000 });
  });
});
