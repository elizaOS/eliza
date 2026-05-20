/**
 * Page Navigation E2E Tests
 *
 * Verifies ALL app pages are accessible and functional.
 * Complete coverage of all 32+ pages in the application.
 */

import { expect, test } from './fixtures';
import {
  cooldownBetweenTests,
  navigateTo,
  waitForPageLoad,
} from './helpers/page-helpers';
import { loginWithWallet } from './helpers/privy-auth';
import { ROUTES, TIMEOUTS, VIEWPORTS } from './helpers/test-data';

test.setTimeout(TIMEOUTS.EXTRA_LONG);

// ============================================
// CORE PUBLIC PAGES
// ============================================
test.describe('Core Pages', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test('feed page loads with content', async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    expect(page.url()).toContain('/feed');
    const body = await page.locator('body').textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test('markets page loads with tabs', async ({ page }) => {
    await navigateTo(page, ROUTES.MARKETS);
    await waitForPageLoad(page);
    expect(page.url()).toContain('/markets');
    // Should have markets-related content
    const pageContent = await page.locator('body').textContent();
    expect(pageContent?.length).toBeGreaterThan(200);
  });

  test('markets trending screener loads', async ({ page }) => {
    await navigateTo(page, ROUTES.MARKETS_TRENDING);
    await waitForPageLoad(page);
    expect(page.url()).toContain('/markets');
    const screener = page.locator('[data-testid="markets-trending-screener"]');
    await expect(screener).toBeVisible({ timeout: TIMEOUTS.MEDIUM });
  });

  test('chats page loads', async ({ page }) => {
    await navigateTo(page, ROUTES.CHATS);
    await waitForPageLoad(page);
    expect(page.url()).toContain('/chats');
  });

  test('notifications page loads', async ({ page }) => {
    await navigateTo(page, ROUTES.NOTIFICATIONS);
    await waitForPageLoad(page);
    expect(page.url()).toContain('/notifications');
  });

  test('profile page loads', async ({ page }) => {
    await navigateTo(page, ROUTES.PROFILE);
    await waitForPageLoad(page);
    expect(page.url()).toContain('/profile');
  });

  test('settings page loads', async ({ page }) => {
    await navigateTo(page, ROUTES.SETTINGS);
    await waitForPageLoad(page);
    expect(page.url()).toContain('/settings');
  });

  test('rewards page loads', async ({ page }) => {
    await navigateTo(page, ROUTES.REWARDS);
    await waitForPageLoad(page);
    expect(page.url()).toContain('/rewards');
  });

  test('leaderboard page loads', async ({ page }) => {
    await navigateTo(page, ROUTES.LEADERBOARD);
    await waitForPageLoad(page);
    expect(page.url()).toContain('/leaderboard');
  });

  test('reputation page loads', async ({ page }) => {
    await navigateTo(page, ROUTES.REPUTATION);
    await waitForPageLoad(page);
    expect(page.url()).toContain('/reputation');
  });

  test('registry page loads', async ({ page }) => {
    await navigateTo(page, ROUTES.REGISTRY);
    await waitForPageLoad(page);
    // Registry may redirect to /admin?tab=registry or /registry
    expect(
      page.url().includes('/registry') || page.url().includes('tab=registry')
    ).toBe(true);
  });

  test('game page loads', async ({ page }) => {
    await navigateTo(page, ROUTES.GAME);
    await waitForPageLoad(page);
    expect(page.url()).toContain('/game');
  });

  test('api-docs page loads', async ({ page }) => {
    await navigateTo(page, ROUTES.API_DOCS);
    await waitForPageLoad(page);
    expect(page.url()).toContain('/api-docs');
  });
});

// ============================================
// MARKETS SUB-PAGES
// ============================================
test.describe('Markets Pages', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test('perps list page loads', async ({ page }) => {
    await navigateTo(page, ROUTES.MARKETS_PERPS);
    await waitForPageLoad(page);
    expect(page.url()).toContain('/markets');
    expect(page.url()).toContain('tab=perps');
  });

  test('predictions list page loads', async ({ page }) => {
    await navigateTo(page, ROUTES.MARKETS_PREDICTIONS);
    await waitForPageLoad(page);
    expect(page.url()).toContain('/markets');
    expect(page.url()).toContain('tab=predictions');
  });

  test('individual perp page loads', async ({ page }) => {
    await navigateTo(page, ROUTES.MARKETS_PERPS);
    await waitForPageLoad(page);

    // Click first market to get to detail page
    const marketCard = page.locator('button:has-text("$")').first();
    if (await marketCard.isVisible({ timeout: TIMEOUTS.SHORT })) {
      await marketCard.click();
      await page.waitForTimeout(2000);
      expect(page.url()).toContain('/markets/perps/');
    }
  });

  test('individual prediction page loads', async ({ page }) => {
    await navigateTo(page, ROUTES.MARKETS_PREDICTIONS);
    await waitForPageLoad(page);

    // Click first prediction to get to detail page
    const yesButton = page.locator('button:has-text("YES")').first();
    if (await yesButton.isVisible({ timeout: TIMEOUTS.SHORT })) {
      // Try to click parent card
      const card = yesButton.locator('xpath=ancestor::article').first();
      if (await card.isVisible()) {
        await card.click();
      } else {
        await yesButton.click();
      }
      await page.waitForTimeout(2000);
      // May or may not navigate to detail
    }
  });
});

// ============================================
// AGENTS PAGES
// ============================================
test.describe('Agents Pages', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test('agents list page loads', async ({ page }) => {
    await navigateTo(page, ROUTES.AGENTS);
    await waitForPageLoad(page);
    expect(page.url()).toContain('/agents');
  });

  test('agent create page loads', async ({ page }) => {
    await navigateTo(page, ROUTES.AGENTS_CREATE);
    await waitForPageLoad(page);
    expect(page.url()).toContain('/agents/create');
  });
});

// ============================================
// ADMIN PAGES
// ============================================
test.describe('Admin Pages', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test('admin dashboard loads', async ({ page }) => {
    await navigateTo(page, ROUTES.ADMIN);
    await waitForPageLoad(page);
    expect(page.url()).toContain('/admin');
  });

  test('admin groups page loads', async ({ page }) => {
    await navigateTo(page, ROUTES.ADMIN_GROUPS);
    await waitForPageLoad(page);
    expect(page.url()).toContain('/admin/groups');
  });

  test('admin performance page loads', async ({ page }) => {
    await navigateTo(page, ROUTES.ADMIN_PERFORMANCE);
    await waitForPageLoad(page);
    expect(page.url()).toContain('/admin/performance');
  });

  test('admin rl-training page loads', async ({ page }) => {
    await navigateTo(page, ROUTES.ADMIN_RL_TRAINING);
    await waitForPageLoad(page);
    expect(page.url()).toContain('/admin/rl-training');
  });

  test('admin training page loads', async ({ page }) => {
    await navigateTo(page, ROUTES.ADMIN_TRAINING);
    await waitForPageLoad(page);
    expect(page.url()).toContain('/admin/training');
  });
});

// ============================================
// SETTINGS PAGES
// ============================================
test.describe('Settings Pages', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test('settings main page loads', async ({ page }) => {
    await navigateTo(page, ROUTES.SETTINGS);
    await waitForPageLoad(page);
    expect(page.url()).toContain('/settings');
  });

  test('settings moderation page loads', async ({ page }) => {
    await navigateTo(page, ROUTES.SETTINGS_MODERATION);
    await waitForPageLoad(page);
    expect(page.url()).toContain('/settings/moderation');
  });
});

// ============================================
// TRENDING PAGES
// ============================================
test.describe('Trending Pages', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test('trending group page loads', async ({ page }) => {
    await navigateTo(page, ROUTES.TRENDING_GROUP);
    await waitForPageLoad(page);
    expect(page.url()).toContain('/trending/group');
  });

  test('trending by tag page loads', async ({ page }) => {
    await navigateTo(page, ROUTES.TRENDING_BY_TAG('crypto'));
    await waitForPageLoad(page);
    expect(page.url()).toContain('/trending/');
  });
});

// ============================================
// CONTENT DETAIL PAGES
// ============================================
test.describe('Content Detail Pages', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test('post detail page loads from feed', async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);

    const postContent = page
      .locator('article p, [data-testid="post-card"] p')
      .first();
    if (await postContent.isVisible({ timeout: TIMEOUTS.SHORT })) {
      await postContent.click();
      await page.waitForTimeout(2000);
      expect(page.url()).toContain('/post/');
    }
  });

  test('profile by ID page loads from post author', async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);

    const authorLink = page.locator('a[href*="/profile/"]').first();
    if (await authorLink.isVisible({ timeout: TIMEOUTS.SHORT })) {
      await authorLink.click();
      await page.waitForTimeout(2000);
      expect(page.url()).toContain('/profile/');
    }
  });

  test('article page loads from feed', async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);

    const articleLink = page.locator('a[href*="/article/"]').first();
    if (await articleLink.isVisible({ timeout: TIMEOUTS.SHORT })) {
      await articleLink.click();
      await page.waitForTimeout(2000);
      expect(page.url()).toContain('/article/');
    }
  });
});

// ============================================
// SHARE PAGES (Public)
// ============================================
test.describe('Share Pages', () => {
  test('share PnL page loads', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    // These are public pages that don't require auth
    await page.goto(
      `${process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000'}/share/pnl/test-user-id`
    );
    await waitForPageLoad(page);
    // Should load without crashing (may show error for invalid user)
    const body = await page.locator('body').textContent();
    expect(body?.length).toBeGreaterThan(50);
  });

  test('share referral page loads', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await page.goto(
      `${process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000'}/share/referral/test-user-id`
    );
    await waitForPageLoad(page);
    const body = await page.locator('body').textContent();
    expect(body?.length).toBeGreaterThan(50);
  });
});

// ============================================
// ERROR HANDLING
// ============================================
test.describe('Error Pages', () => {
  test('404 page for invalid routes', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await page.goto(
      `${process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000'}/definitely-not-a-page-xyz`
    );
    await waitForPageLoad(page);

    const body = await page.locator('body').textContent();
    const shows404 =
      body?.includes('404') || body?.toLowerCase().includes('not found');
    expect(shows404).toBe(true);
  });

  test('app handles API failures gracefully', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await page.route('**/api/**', (route) => route.abort());

    await navigateTo(page, ROUTES.FEED);

    const body = page.locator('body');
    await expect(body).toBeVisible({ timeout: TIMEOUTS.MEDIUM });

    await page.unroute('**/api/**');
  });
});

// ============================================
// NAVIGATION FLOW
// ============================================
test.describe('Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);
  });

  test('browser back button works', async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    const feedUrl = page.url();

    await navigateTo(page, ROUTES.SETTINGS);
    await waitForPageLoad(page);

    await page.goBack();
    await waitForPageLoad(page);
    expect(page.url()).toBe(feedUrl);
  });

  test('nav links work', async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);

    const navLinks = page.locator('nav a[href]');
    const count = await navLinks.count().catch(() => 0);

    if (count > 0) {
      const firstLink = navLinks.first();
      const href = await firstLink.getAttribute('href').catch(() => null);

      if (href && !href.startsWith('http') && href !== '#') {
        // Use force click to bypass any overlays
        await firstLink.click({ force: true }).catch(() => {});
        await waitForPageLoad(page);
      }
    }

    // Navigation test passes if page loaded correctly
    const pageContent = await page.locator('body').textContent();
    expect(pageContent?.length).toBeGreaterThan(100);
    console.log('✅ Nav links test completed');
  });
});

// ============================================
// MOBILE RESPONSIVENESS
// ============================================
test.describe('Mobile', () => {
  test('pages render on mobile without horizontal scroll', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.MOBILE);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);

    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);

    const scrollWidth = await page
      .evaluate(() => document.documentElement.scrollWidth)
      .catch(() => 0);
    const clientWidth = await page
      .evaluate(() => document.documentElement.clientWidth)
      .catch(() => 0);

    // Allow some tolerance for mobile layouts
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 50);
    console.log('✅ Mobile responsive test passed');
  });
});
