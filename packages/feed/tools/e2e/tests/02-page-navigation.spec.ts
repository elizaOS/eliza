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

test.describe("Page Navigation - Public Pages", () => {
  test.beforeEach(async ({ page }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("feed page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    const hasContent = await pageContainsText(page, "feed", "post", "latest");
    expect(hasContent).toBe(true);
  });

  test("markets page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.MARKETS);
    await waitForPageLoad(page);
    const hasContent = await pageContainsText(page, "market", "trade", "price");
    expect(hasContent).toBe(true);
  });

  test("leaderboard page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.LEADERBOARD);
    await waitForPageLoad(page);
    const hasContent = await pageContainsText(
      page,
      "leaderboard",
      "rank",
      "top",
    );
    expect(hasContent).toBe(true);
  });

  test("reputation page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.REPUTATION);
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("registry page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.REGISTRY);
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("game page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.GAME);
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("API docs page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.API_DOCS);
    await waitForPageLoad(page);
    const hasContent = await pageContainsText(page, "api", "docs", "endpoint");
    expect(hasContent).toBe(true);
  });

  test("markets perps sub-page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.MARKETS_PERPS);
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("markets predictions sub-page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.MARKETS_PREDICTIONS);
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("trending group page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.TRENDING_GROUP);
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("trending by tag page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.TRENDING_BY_TAG("crypto"));
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("404 page for unknown route", async ({ page }) => {
    await navigateTo(page, "/this-route-does-not-exist-12345");
    await waitForPageLoad(page);
    const hasContent = await pageContainsText(
      page,
      "404",
      "not found",
      "page not found",
    );
    expect(hasContent).toBe(true);
  });
});

test.describe("Page Navigation - Authenticated Pages", () => {
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

  test("chats page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.CHATS);
    await waitForPageLoad(page);
    const hasContent = await pageContainsText(
      page,
      "chat",
      "message",
      "conversation",
    );
    expect(hasContent).toBe(true);
  });

  test("notifications page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.NOTIFICATIONS);
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("profile page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.PROFILE);
    await waitForPageLoad(page);
    const hasContent = await pageContainsText(
      page,
      "profile",
      "wallet",
      "edit",
    );
    expect(hasContent).toBe(true);
  });

  test("settings page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.SETTINGS);
    await waitForPageLoad(page);
    const hasContent = await pageContainsText(
      page,
      "settings",
      "preferences",
      "account",
    );
    expect(hasContent).toBe(true);
  });

  test("rewards page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.REWARDS);
    await waitForPageLoad(page);
    const hasContent = await pageContainsText(page, "reward", "claim", "earn");
    expect(hasContent).toBe(true);
  });

  test("agents list page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.AGENTS);
    await waitForPageLoad(page);
    const hasContent = await pageContainsText(page, "agent", "create", "list");
    expect(hasContent).toBe(true);
  });

  test("agents create page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.AGENTS_CREATE);
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("agents team chat page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.AGENTS_TEAM_CHAT);
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("wallet page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.WALLET);
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("admin dashboard loads", async ({ page }) => {
    await navigateTo(page, ROUTES.ADMIN);
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("admin groups page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.ADMIN_GROUPS);
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("admin performance page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.ADMIN_PERFORMANCE);
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("settings moderation page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.SETTINGS);
    await waitForPageLoad(page);
    const hasContent = await pageContainsText(page, "settings");
    expect(hasContent).toBe(true);
  });

  test("NFT page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.NFT);
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });
});

test.describe("Page Navigation - Content Detail Pages", () => {
  test.beforeEach(async ({ page }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("post detail page loads with valid ID", async ({ page }) => {
    await navigateTo(page, ROUTES.POST_BY_ID("test-post-id"));
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("profile by ID page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.PROFILE_BY_ID("test-user-id"));
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });
});

test.describe("Page Navigation - Navigation Controls", () => {
  test.beforeEach(async ({ page }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("back button navigates to previous page", async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    await navigateTo(page, ROUTES.MARKETS);
    await waitForPageLoad(page);
    await page.goBack();
    await waitForPageLoad(page);
    const url = page.url();
    expect(url).toContain("feed");
  });

  test("nav links are clickable", async ({ page }) => {
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    const navLinks = page.locator(SELECTORS.NAV_LINK);
    const count = await navLinks.count().catch(() => 0);
    expect(count).toBeGreaterThan(0);
  });
});

test.describe("Page Navigation - Mobile Responsive", () => {
  test.beforeEach(async ({ page }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.MOBILE);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("feed renders on mobile viewport", async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("markets renders on mobile viewport", async ({ page }) => {
    await navigateTo(page, ROUTES.MARKETS);
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("bottom nav visible on mobile", async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    // BottomNav (shared/BottomNav.tsx) is `fixed bottom-0 ... md:hidden`:
    // it must be visible at the mobile viewport.
    const bottomNav = page.locator(SELECTORS.BOTTOM_NAV).first();
    await expect(bottomNav).toBeVisible({ timeout: 5000 });
  });

  test("research page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.RESEARCH);
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });
});
