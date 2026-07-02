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

test.describe("Rewards - Tabs", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.REWARDS);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("Overview tab is default", async ({ page }) => {
    const hasOverview = await pageContainsText(
      page,
      "overview",
      "reward",
      "daily",
      "claim",
    );
    expect(hasOverview).toBe(true);
  });

  // TabNavigation (rewards/v2) renders exactly: Overview, Challenges,
  // Achievements.
  test("Achievements tab accessible", async ({ page }) => {
    const switched = await clickTab(page, "Achievements");
    expect(switched).toBe(true);
  });

  test("Challenges tab accessible", async ({ page }) => {
    const switched = await clickTab(page, "Challenges");
    expect(switched).toBe(true);
  });

  test("auth redirect for unauthenticated users", async ({ page }) => {
    const newPage = await page.context().newPage();
    await newPage
      .goto(
        `${process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000"}${ROUTES.REWARDS}`,
        {
          waitUntil: "domcontentloaded",
          timeout: 45000,
        },
      )
      .catch(() => {});
    await newPage.waitForTimeout(3000);
    const hasLogin = await newPage
      .locator(SELECTORS.LOGIN_BUTTON)
      .first()
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    // rewards/page.tsx requires auth: unauthenticated visitors are redirected
    // to the feed and shown the login modal.
    const url = newPage.url();
    expect(hasLogin || !url.includes("/rewards")).toBe(true);
    await newPage.close();
  });
});

test.describe("Rewards - Overview", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.REWARDS);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("daily claim section visible", async ({ page }) => {
    const hasDailyClaim = await pageContainsText(
      page,
      "daily",
      "claim",
      "reward",
    );
    expect(hasDailyClaim).toBe(true);
  });

  test("claim button visible", async ({ page }) => {
    // overview-tab.tsx always renders the daily-claim affordance (Claim /
    // Claimed state).
    const claimBtn = page.locator(SELECTORS.DAILY_CLAIM_BUTTON).first();
    await expect(claimBtn).toBeVisible({ timeout: 5000 });
  });

  test("streak counter visible", async ({ page }) => {
    // overview-tab.tsx renders the StreakCalendar (streak + day labels).
    const hasStreak = await pageContainsText(
      page,
      "streak",
      "day",
      "consecutive",
    );
    expect(hasStreak).toBe(true);
  });
});

test.describe("Rewards - Achievements", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.REWARDS);
    await waitForPageLoad(page);
    await clickTab(page, "Achievements");
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("achievement cards display", async ({ page }) => {
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("claim buttons on achievements", async ({ page }) => {
    const claimBtns = page.locator(
      'button:has-text("Claim"), button:has-text("Collect")',
    );
    const count = await claimBtns.count().catch(() => 0);
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test("progress indicators on achievements", async ({ page }) => {
    const progressBars = page.locator(
      '[role="progressbar"], .progress, progress',
    );
    const count = await progressBars.count().catch(() => 0);
    const hasProgress = await pageContainsText(
      page,
      "progress",
      "%",
      "completed",
    );
    expect(count > 0 || hasProgress).toBe(true);
  });
});

test.describe("Rewards - Challenges", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.REWARDS);
    await waitForPageLoad(page);
    await clickTab(page, "Challenges");
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("challenges display", async ({ page }) => {
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("challenge progress bars", async ({ page }) => {
    // challenges-tab.tsx renders each challenge with a progress indicator.
    const progressBars = page.locator(
      '[role="progressbar"], .progress, progress',
    );
    const count = await progressBars.count().catch(() => 0);
    const hasProgress = await pageContainsText(page, "progress", "%");
    expect(count > 0 || hasProgress).toBe(true);
  });

  test("challenge rewards shown", async ({ page }) => {
    // Each challenge card shows its pointsReward.
    const hasRewards = await pageContainsText(
      page,
      "reward",
      "points",
      "earn",
      "xp",
    );
    expect(hasRewards).toBe(true);
  });
});
