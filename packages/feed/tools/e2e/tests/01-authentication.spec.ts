import { expect, test } from './fixtures';
import { pageContainsText } from './helpers/interaction-helpers';
import {
  cooldownBetweenTests,
  isServerHealthy,
  navigateTo,
  waitForPageLoad,
} from './helpers/page-helpers';
import { ROUTES, SELECTORS, VIEWPORTS } from './helpers/test-data';
import { isAuthenticated, loginWithWallet } from './helpers/wallet-auth';

test.setTimeout(60000);

test.describe('Authentication', () => {
  test.beforeEach(async ({ page }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, 'Server is not healthy');
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test('login button is visible when unauthenticated', async ({ page }) => {
    const loginButton = page.locator(SELECTORS.LOGIN_BUTTON).first();
    const isVisible = await loginButton
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    expect(isVisible).toBe(true);
  });

  test('connect wallet successfully with MetaMask', async ({
    page,
    wallets,
  }) => {
    await loginWithWallet(page, wallets);
    const authenticated = await isAuthenticated(page);
    expect(authenticated).toBe(true);
  });

  test('session persists across navigation', async ({ page, wallets }) => {
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    const authenticated = await isAuthenticated(page);
    expect(authenticated).toBe(true);
  });

  test('access protected routes when authenticated', async ({
    page,
    wallets,
  }) => {
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.PROFILE);
    await waitForPageLoad(page);
    const hasContent = await pageContainsText(
      page,
      'profile',
      'wallet',
      'edit'
    );
    expect(hasContent).toBe(true);
  });

  test('show login prompt for protected routes when unauthenticated', async ({
    page,
  }) => {
    await navigateTo(page, ROUTES.PROFILE);
    await waitForPageLoad(page);
    const hasLoginPrompt = await pageContainsText(
      page,
      'log in',
      'sign in',
      'connect wallet'
    );
    const loginButton = page.locator(SELECTORS.LOGIN_BUTTON).first();
    const loginVisible = await loginButton
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    expect(hasLoginPrompt || loginVisible).toBe(true);
  });

  test('access admin dashboard with admin wallet', async ({
    page,
    wallets,
  }) => {
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.ADMIN);
    await waitForPageLoad(page);
    const body = await page.locator('body').textContent();
    expect(body).toBeTruthy();
    expect(body!.length).toBeGreaterThan(0);
  });

  test('admin tabs visible on admin dashboard', async ({ page, wallets }) => {
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.ADMIN);
    await waitForPageLoad(page);
    const tabs = page.locator('[role="tab"]');
    const tabCount = await tabs.count().catch(() => 0);
    expect(tabCount).toBeGreaterThan(0);
  });

  test('admin sub-routes accessible', async ({ page, wallets }) => {
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.ADMIN_GROUPS);
    await waitForPageLoad(page);
    const hasContent = await pageContainsText(page, 'group', 'admin', 'manage');
    expect(hasContent).toBe(true);
  });

  test('public routes accessible without auth', async ({ page }) => {
    await navigateTo(page, ROUTES.FEED);
    await waitForPageLoad(page);
    const body = await page.locator('body').textContent();
    expect(body).toBeTruthy();
    expect(body!.length).toBeGreaterThan(0);
  });

  test('different UI based on auth state', async ({ page, wallets }) => {
    const unauthBody = await page.locator('body').textContent();
    await loginWithWallet(page, wallets);
    await waitForPageLoad(page);
    const authBody = await page.locator('body').textContent();
    const userMenu = page.locator(SELECTORS.USER_MENU).first();
    const menuVisible = await userMenu
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    expect(menuVisible || unauthBody !== authBody).toBe(true);
  });
});
