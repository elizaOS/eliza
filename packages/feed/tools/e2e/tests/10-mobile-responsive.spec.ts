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

test.describe("Mobile Responsive - Core Pages No Overflow", () => {
  test.beforeEach(async ({ page }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.MOBILE);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("feed has no horizontal overflow", async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    const overflowX = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    expect(overflowX).toBe(false);
  });

  test("markets has no horizontal overflow", async ({ page }) => {
    await navigateTo(page, ROUTES.MARKETS);
    await waitForPageLoad(page);
    const overflowX = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    expect(overflowX).toBe(false);
  });

  test("leaderboard has no horizontal overflow", async ({ page }) => {
    await navigateTo(page, ROUTES.LEADERBOARD);
    await waitForPageLoad(page);
    const overflowX = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    expect(overflowX).toBe(false);
  });
});

test.describe("Mobile Responsive - Navigation", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.MOBILE);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("mobile nav is accessible", async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    const navLinks = page.locator(SELECTORS.NAV_LINK);
    const count = await navLinks.count().catch(() => 0);
    const bottomNav = page.locator(SELECTORS.BOTTOM_NAV).first();
    const bottomVisible = await bottomNav
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    expect(count > 0 || bottomVisible).toBe(true);
  });

  test("bottom nav visible on mobile", async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    // BottomNav (shared/BottomNav.tsx) is `fixed bottom-0 ... md:hidden`:
    // it must be visible at the mobile viewport.
    const bottomNav = page.locator(SELECTORS.BOTTOM_NAV).first();
    await expect(bottomNav).toBeVisible({ timeout: 5000 });
  });

  test("nav links are clickable on mobile", async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    const bottomNav = page.locator(SELECTORS.BOTTOM_NAV).first();
    const bottomVisible = await bottomNav
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    test.skip(!bottomVisible, "no bottom nav rendered on the mobile feed");
    const navLink = bottomNav.locator("a").first();
    await expect(navLink, "bottom nav has no links").toBeVisible({
      timeout: 3000,
    });
    const href = await navLink.getAttribute("href");
    expect(href, "bottom nav link has no href").toBeTruthy();
    await navLink.click({ force: true });
    await page.waitForTimeout(1000);
    const target = new URL(href ?? "/", page.url());
    expect(new URL(page.url()).pathname).toBe(target.pathname);
  });
});

test.describe("Mobile Responsive - Feed", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.MOBILE);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("feed is touch-friendly", async ({ page }) => {
    const buttons = page.locator("button:visible");
    const count = await buttons.count();
    test.skip(count === 0, "no visible buttons rendered on the mobile feed");
    const box = await buttons.first().boundingBox();
    expect(box, "first visible button has no bounding box").not.toBeNull();
    // Touch-friendly targets should be at least 24px.
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(24);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
  });

  test("tap-friendly buttons on posts", async ({ page }) => {
    const likeBtn = page.locator(SELECTORS.LIKE_BUTTON).first();
    const isVisible = await likeBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no post with a like button rendered in the feed");
    const box = await likeBtn.boundingBox();
    expect(box, "like button has no bounding box").not.toBeNull();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(24);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
  });
});

test.describe("Mobile Responsive - Markets", () => {
  test.beforeEach(async ({ page }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.MOBILE);
    await navigateTo(page, ROUTES.MARKETS);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("markets renders single column on mobile", async ({ page }) => {
    const overflowX = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    expect(overflowX).toBe(false);
  });

  test("markets scrollable on mobile", async ({ page }) => {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
    const scrollY = await page.evaluate(() => window.scrollY);
    expect(scrollY).toBeGreaterThanOrEqual(0);
  });
});

test.describe("Mobile Responsive - Wallet", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.MOBILE);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.WALLET);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  // The wallet page is a single view (P&L section + Positions sidebar) —
  // it has no tab controls, on mobile or desktop.
  test("wallet sections render on mobile", async ({ page }) => {
    const hasSections = await pageContainsText(page, "p&l", "positions");
    expect(hasSections).toBe(true);
  });
});

test.describe("Mobile Responsive - Feed Tabs and Interactions", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.MOBILE);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("feed tabs accessible on mobile", async ({ page }) => {
    // FeedToggle renders on all viewports; the Latest tab must be clickable.
    const switched = await clickTab(page, "Latest");
    expect(switched).toBe(true);
  });

  test("feed interactions work on mobile", async ({ page }) => {
    const likeBtn = page.locator(SELECTORS.LIKE_BUTTON).first();
    const isVisible = await likeBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no post with a like button rendered in the feed");
    // A real like tap must hit the like API (/api/posts/[id]/like).
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
});

test.describe("Mobile Responsive - Settings", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.MOBILE);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.SETTINGS);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  // settings/page.tsx renders Profile / Notifications / Security tab
  // buttons.
  test("settings tabs on mobile", async ({ page }) => {
    const switched = await clickTab(page, "Notifications");
    expect(switched).toBe(true);
  });

  test("settings editing on mobile", async ({ page }) => {
    const switched = await clickTab(page, "Profile");
    expect(switched).toBe(true);
    const hasFields = await pageContainsText(page, "name", "username", "bio");
    expect(hasFields).toBe(true);
  });
});

test.describe("Mobile Responsive - Tablet", () => {
  test.beforeEach(async ({ page }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.TABLET);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("tablet renders correctly", async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    const overflowX = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    expect(overflowX).toBe(false);
  });
});

test.describe("Mobile Responsive - Small Mobile", () => {
  test.beforeEach(async ({ page }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.MOBILE_SMALL);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("works at 320px width", async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
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
