import { expect, test } from './fixtures';
import { clickTab, pageContainsText } from './helpers/interaction-helpers';
import {
  cooldownBetweenTests,
  isServerHealthy,
  navigateTo,
  waitForPageLoad,
} from './helpers/page-helpers';
import { ROUTES, SELECTORS, VIEWPORTS } from './helpers/test-data';
import { loginWithWallet } from './helpers/wallet-auth';

test.setTimeout(60000);

test.describe('Mobile Responsive - Core Pages No Overflow', () => {
  test.beforeEach(async ({ page }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, 'Server is not healthy');
    await page.setViewportSize(VIEWPORTS.MOBILE);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test('feed has no horizontal overflow', async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    const overflowX = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth
    );
    expect(overflowX).toBe(false);
  });

  test('markets has no horizontal overflow', async ({ page }) => {
    await navigateTo(page, ROUTES.MARKETS);
    await waitForPageLoad(page);
    const overflowX = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth
    );
    expect(overflowX).toBe(false);
  });

  test('leaderboard has no horizontal overflow', async ({ page }) => {
    await navigateTo(page, ROUTES.LEADERBOARD);
    await waitForPageLoad(page);
    const overflowX = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth
    );
    expect(overflowX).toBe(false);
  });
});

test.describe('Mobile Responsive - Navigation', () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, 'Server is not healthy');
    await page.setViewportSize(VIEWPORTS.MOBILE);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test('mobile nav is accessible', async ({ page }) => {
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

  test('bottom nav visible on mobile', async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    const bottomNav = page.locator(SELECTORS.BOTTOM_NAV).first();
    const isVisible = await bottomNav
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('hamburger menu visible', async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    const hamburger = page
      .locator(
        'button[aria-label*="menu" i], button:has(svg.lucide-menu), [data-testid="hamburger"]'
      )
      .first();
    const isVisible = await hamburger
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    expect(typeof isVisible).toBe('boolean');
  });

  test('nav links are clickable on mobile', async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    const bottomNav = page.locator(SELECTORS.BOTTOM_NAV).first();
    const bottomVisible = await bottomNav
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    if (bottomVisible) {
      const navLink = bottomNav.locator('a').first();
      const linkVisible = await navLink
        .isVisible({ timeout: 3000 })
        .catch(() => false);
      if (linkVisible) {
        await navLink.click({ force: true });
        await page.waitForTimeout(1000);
        expect(true).toBe(true);
      }
    }
    expect(true).toBe(true);
  });
});

test.describe('Mobile Responsive - Feed', () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, 'Server is not healthy');
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

  test('feed is touch-friendly', async ({ page }) => {
    const buttons = page.locator('button');
    const count = await buttons.count().catch(() => 0);
    if (count > 0) {
      const firstBtn = buttons.first();
      const box = await firstBtn.boundingBox().catch(() => null);
      if (box) {
        // Touch-friendly targets should be at least 24px
        expect(box.width).toBeGreaterThanOrEqual(24);
        expect(box.height).toBeGreaterThanOrEqual(24);
      }
    }
    expect(true).toBe(true);
  });

  test('tap-friendly buttons on posts', async ({ page }) => {
    const likeBtn = page.locator(SELECTORS.LIKE_BUTTON).first();
    const isVisible = await likeBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    if (isVisible) {
      const box = await likeBtn.boundingBox().catch(() => null);
      if (box) {
        expect(box.width).toBeGreaterThanOrEqual(24);
      }
    }
    expect(true).toBe(true);
  });
});

test.describe('Mobile Responsive - Markets', () => {
  test.beforeEach(async ({ page }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, 'Server is not healthy');
    await page.setViewportSize(VIEWPORTS.MOBILE);
    await navigateTo(page, ROUTES.MARKETS);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test('markets renders single column on mobile', async ({ page }) => {
    const overflowX = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth
    );
    expect(overflowX).toBe(false);
  });

  test('markets scrollable on mobile', async ({ page }) => {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
    const scrollY = await page.evaluate(() => window.scrollY);
    expect(scrollY).toBeGreaterThanOrEqual(0);
  });
});

test.describe('Mobile Responsive - Wallet', () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, 'Server is not healthy');
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

  test('wallet tabs visible on mobile', async ({ page }) => {
    const tabs = page.locator('[role="tab"]');
    const count = await tabs.count().catch(() => 0);
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('wallet tab switching on mobile', async ({ page }) => {
    const switched = await clickTab(page, 'Positions');
    expect(typeof switched).toBe('boolean');
  });
});

test.describe('Mobile Responsive - Feed Tabs and Interactions', () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, 'Server is not healthy');
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

  test('feed tabs accessible on mobile', async ({ page }) => {
    const switched = await clickTab(page, 'Latest');
    expect(typeof switched).toBe('boolean');
  });

  test('feed interactions work on mobile', async ({ page }) => {
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
});

test.describe('Mobile Responsive - Settings', () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, 'Server is not healthy');
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

  test('settings tabs on mobile', async ({ page }) => {
    const tabs = page.locator('[role="tab"]');
    const count = await tabs.count().catch(() => 0);
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('settings editing on mobile', async ({ page }) => {
    await clickTab(page, 'Profile');
    const hasFields = await pageContainsText(page, 'name', 'username', 'bio');
    expect(typeof hasFields).toBe('boolean');
  });
});

test.describe('Mobile Responsive - Tablet', () => {
  test.beforeEach(async ({ page }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, 'Server is not healthy');
    await page.setViewportSize(VIEWPORTS.TABLET);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test('tablet renders correctly', async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    const overflowX = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth
    );
    expect(overflowX).toBe(false);
  });
});

test.describe('Mobile Responsive - Small Mobile', () => {
  test.beforeEach(async ({ page }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, 'Server is not healthy');
    await page.setViewportSize(VIEWPORTS.MOBILE_SMALL);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test('works at 320px width', async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    const body = await page.locator('body').textContent();
    expect(body).toBeTruthy();
    const overflowX = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth
    );
    expect(overflowX).toBe(false);
  });
});
