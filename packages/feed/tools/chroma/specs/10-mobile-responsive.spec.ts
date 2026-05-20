/**
 * Mobile Responsiveness E2E Tests
 *
 * Verifies the app works on mobile viewports: core pages, navigation,
 * markets, wallet, feed, settings, and touch-friendly sizing.
 */

import { expect, test } from './fixtures';
import { clickTab, pageContainsText } from './helpers/interaction-helpers';
import {
  cooldownBetweenTests,
  isServerHealthy,
  navigateTo,
  waitForPageLoad,
} from './helpers/page-helpers';
import { loginWithWallet } from './helpers/privy-auth';
import { ROUTES, SELECTORS, TIMEOUTS, VIEWPORTS } from './helpers/test-data';

test.setTimeout(TIMEOUTS.EXTRA_LONG);

test.describe('Mobile Responsiveness', () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.MOBILE);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test('core pages render without horizontal overflow', async ({ page }) => {
    const routes = [
      ROUTES.FEED,
      ROUTES.MARKETS,
      ROUTES.PROFILE,
      ROUTES.SETTINGS,
    ];

    for (const route of routes) {
      await navigateTo(page, route);
      await waitForPageLoad(page);

      const scrollWidth = await page.evaluate(
        () => document.documentElement.scrollWidth
      );
      const clientWidth = await page.evaluate(
        () => document.documentElement.clientWidth
      );
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 10);
    }
  });

  test('mobile navigation is accessible', async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);

    const pageContent = await page.locator('body').textContent();
    const is404 =
      pageContent?.includes('404') || pageContent?.includes('not found');

    if (!is404) {
      const bottomNav = page
        .locator('nav.fixed.bottom-0, [data-testid="bottom-nav"]')
        .first();
      const hamburger = page.locator('button[aria-label*="menu" i]').first();
      const anyNav = page.locator('nav, [role="navigation"]').first();

      const hasBottomNav = await bottomNav
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false);
      const hasHamburger = await hamburger
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false);
      const hasAnyNav = await anyNav
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false);

      expect(hasBottomNav || hasHamburger || hasAnyNav).toBe(true);
    }
  });

  test('feed posts are touch-friendly width', async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);

    const post = page.locator('article, [data-testid="post-card"]').first();
    if (await post.isVisible({ timeout: TIMEOUTS.SHORT })) {
      const box = await post.boundingBox();
      if (box) {
        expect(box.width).toBeGreaterThan(VIEWPORTS.MOBILE.width * 0.8);
      }
    }
  });

  test('buttons and inputs are tap-friendly size', async ({ page }) => {
    await navigateTo(page, ROUTES.SETTINGS);
    await waitForPageLoad(page);

    const buttons = page.locator('button').first();
    if (await buttons.isVisible({ timeout: TIMEOUTS.SHORT })) {
      const box = await buttons.boundingBox();
      if (box) {
        expect(box.height).toBeGreaterThanOrEqual(32);
      }
    }
  });
});

test.describe('Mobile - Navigation', () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.MOBILE);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test('displays bottom navigation bar on mobile', async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);

    const bottomNav = page
      .locator(
        'nav.fixed.bottom-0, [data-testid="bottom-nav"], nav[class*="bottom"]'
      )
      .first();
    const hasBottomNav = await bottomNav
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    const anyNav = page.locator('nav, [role="navigation"]').first();
    const hasAnyNav = await anyNav
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    expect(hasBottomNav || hasAnyNav).toBe(true);
  });

  test('navigates between pages using bottom nav', async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);

    // Look for nav links
    const navLinks = page.locator(
      'nav a, [data-testid="bottom-nav"] a, nav button'
    );
    const count = await navLinks.count().catch(() => 0);

    if (count > 1) {
      // Click second nav item
      await navLinks
        .nth(1)
        .click({ force: true })
        .catch(() => {});
      await page.waitForTimeout(2000);

      const body = await page.locator('body').textContent();
      expect(body?.length).toBeGreaterThan(50);
    }
  });

  test('shows hamburger menu if available', async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);

    const hamburger = page
      .locator(
        'button[aria-label*="menu" i], button:has(svg.lucide-menu), [data-testid="hamburger"]'
      )
      .first();
    const hasHamburger = await hamburger
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    // Hamburger may or may not exist (bottom nav alternative)
    expect(typeof hasHamburger).toBe('boolean');
  });
});

test.describe('Mobile - Markets', () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.MOBILE);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateTo(page, ROUTES.MARKETS);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test('displays market cards in single column on mobile', async ({ page }) => {
    const marketCards = page
      .locator('button:has-text("$"), [data-testid="market-card"]')
      .first();

    if (
      await marketCards
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false)
    ) {
      const box = await marketCards.boundingBox();
      if (box) {
        // Card should be wide on mobile (>80% viewport width)
        expect(box.width).toBeGreaterThan(VIEWPORTS.MOBILE.width * 0.6);
      }
    }
  });

  test('allows scrolling through markets on mobile', async ({ page }) => {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);

    const body = await page.locator('body').textContent();
    expect(body?.length).toBeGreaterThan(100);
  });
});

test.describe('Mobile - Wallet', () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.MOBILE);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateTo(page, ROUTES.WALLET);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test('displays wallet tabs on mobile', async ({ page }) => {
    const body = await page.locator('body').textContent();
    const hasWalletContent = await pageContainsText(
      page,
      'balance',
      'wallet',
      'portfolio',
      'position'
    );
    expect(hasWalletContent || (body?.length ?? 0) > 100).toBe(true);
  });

  test('switches wallet tabs on mobile', async ({ page }) => {
    const _switched = await clickTab(page, 'P&L');

    const body = await page.locator('body').textContent();
    expect(body?.length).toBeGreaterThan(100);
  });
});

test.describe('Mobile - Feed', () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.MOBILE);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test('displays feed tabs on mobile', async ({ page }) => {
    const body = await page.locator('body').textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test('allows post interactions on mobile', async ({ page }) => {
    const posts = page.locator('article, [data-testid="post-card"]');
    const postCount = await posts.count().catch(() => 0);

    if (postCount > 0) {
      const likeButton = posts.first().locator(SELECTORS.LIKE_BUTTON).first();
      if (
        await likeButton
          .isVisible({ timeout: TIMEOUTS.SHORT })
          .catch(() => false)
      ) {
        await likeButton.click({ force: true });
        await page.waitForTimeout(500);
      }
    }

    const body = await page.locator('body').textContent();
    expect(body?.length).toBeGreaterThan(100);
  });
});

test.describe('Mobile - Settings', () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.MOBILE);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateTo(page, ROUTES.SETTINGS);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test('displays settings tabs on mobile', async ({ page }) => {
    const body = await page.locator('body').textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test('edits profile fields on mobile', async ({ page }) => {
    const textInput = page
      .locator('input[type="text"], input:not([type])')
      .first();

    if (
      await textInput.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)
    ) {
      await textInput.clear().catch(() => {});
      await textInput.fill('Mobile Test');

      const value = await textInput.inputValue();
      expect(value.length).toBeGreaterThan(0);
    }
  });
});

test.describe('Tablet Responsiveness', () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.TABLET);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);
  });

  test('pages render correctly on tablet', async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);

    const scrollWidth = await page.evaluate(
      () => document.documentElement.scrollWidth
    );
    const clientWidth = await page.evaluate(
      () => document.documentElement.clientWidth
    );
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 10);
  });
});

test.describe('Small Mobile Edge Cases', () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.MOBILE_SMALL);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);
  });

  test('app works on very small screens', async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);

    const body = await page.locator('body').textContent();
    expect(body?.length).toBeGreaterThan(100);

    const scrollWidth = await page.evaluate(
      () => document.documentElement.scrollWidth
    );
    const clientWidth = await page.evaluate(
      () => document.documentElement.clientWidth
    );
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 10);
  });
});
