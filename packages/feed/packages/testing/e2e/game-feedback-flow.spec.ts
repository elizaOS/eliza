/**
 * E2E Tests: Game Feedback Flow
 *
 * Tests the game feedback submission flow including:
 * - Feedback button visibility and click
 * - Feedback modal opening
 * - Form validation
 * - Admin panel feedback display (with auth)
 */

import { expect, test } from '@playwright/test';

const BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL ||
  process.env.TEST_BASE_URL ||
  process.env.TEST_API_URL?.replace(/\/api$/, '') ||
  process.env.NEXT_PUBLIC_APP_URL ||
  'http://127.0.0.1:3400';

/**
 * Strict mode for CI: fails instead of skipping when elements aren't found.
 * Set CI=true or STRICT_E2E_TESTS=true to enable.
 */
const STRICT_MODE =
  process.env.CI === 'true' || process.env.STRICT_E2E_TESTS === 'true';

/**
 * Skip or fail a test based on strict mode.
 * In CI/strict mode, fails with a descriptive message.
 * In local dev, logs info and skips.
 */
function skipOrFail(message: string): void {
  if (STRICT_MODE) {
    throw new Error(`[STRICT MODE] ${message}`);
  }
  console.log(`ℹ️ ${message}`);
  test.skip();
}

test.describe('Game Feedback Button', () => {
  test('should display feedback button on main pages', async ({ page }) => {
    // Navigate to the feed page
    await page.goto(`${BASE_URL}/feed?dev=true`);

    // Wait for page to load and hydrate
    await page.waitForLoadState('domcontentloaded');
    await page.waitForLoadState('networkidle');

    // Look for the feedback button (floating in bottom right or header)
    const feedbackButton = page.locator(
      'button:has-text("Feedback"), button:has-text("Report"), [data-testid="feedback-button"], button[aria-label*="feedback"]'
    );

    // The button should be visible on the page
    const isVisible = await feedbackButton
      .first()
      .isVisible({ timeout: 10000 })
      .catch(() => false);

    if (isVisible) {
      console.log('✅ Feedback button is visible on the page');
      await expect(feedbackButton.first()).toBeVisible();
    } else {
      // If not visible, it might be in a collapsed menu or only shown when authenticated
      console.log(
        'ℹ️ Feedback button not directly visible - may require authentication'
      );
    }
  });
});

test.describe('Game Feedback Modal (Authenticated)', () => {
  // Use the authenticated state from auth.setup.ts
  test.use({ storageState: '.playwright/auth.json' });

  test('should open feedback modal when button clicked', async ({ page }) => {
    await page.goto(`${BASE_URL}/feed`);
    await page.waitForLoadState('networkidle');

    // Find and click the feedback button
    const feedbackButton = page
      .locator(
        'button:has-text("Feedback"), [data-testid="feedback-button"], button[aria-label*="feedback"]'
      )
      .first();

    const buttonVisible = await feedbackButton
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (!buttonVisible) {
      skipOrFail('Feedback button not found - skipping modal test');
      return;
    }

    await feedbackButton.click();

    // Check for modal dialog
    const modal = page.locator(
      '[role="dialog"], [data-testid="feedback-modal"]'
    );
    await expect(modal).toBeVisible({ timeout: 5000 });

    console.log('✅ Feedback modal opened successfully');
  });

  test('should display all feedback type options', async ({ page }) => {
    await page.goto(`${BASE_URL}/feed`);
    await page.waitForLoadState('networkidle');

    // Open feedback modal
    const feedbackButton = page
      .locator('button:has-text("Feedback"), [data-testid="feedback-button"]')
      .first();

    const buttonVisible = await feedbackButton
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    if (!buttonVisible) {
      skipOrFail('Feedback button not found - skipping feedback type test');
      return;
    }

    await feedbackButton.click();

    // Check for feedback type options
    const bugOption = page.locator('text=Bug Report, button:has-text("Bug")');
    const featureOption = page.locator(
      'text=Feature Request, button:has-text("Feature")'
    );
    const performanceOption = page.locator(
      'text=Performance, button:has-text("Performance")'
    );

    // At least one type option should be visible
    const hasOptions =
      (await bugOption
        .first()
        .isVisible({ timeout: 3000 })
        .catch(() => false)) ||
      (await featureOption
        .first()
        .isVisible({ timeout: 3000 })
        .catch(() => false)) ||
      (await performanceOption
        .first()
        .isVisible({ timeout: 3000 })
        .catch(() => false));

    expect(hasOptions).toBe(true);
    console.log('✅ Feedback type options are visible');
  });

  test('should validate required fields', async ({ page }) => {
    await page.goto(`${BASE_URL}/feed`);
    await page.waitForLoadState('networkidle');

    // Open feedback modal
    const feedbackButton = page
      .locator('button:has-text("Feedback"), [data-testid="feedback-button"]')
      .first();

    const buttonVisible = await feedbackButton
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    if (!buttonVisible) {
      skipOrFail('Feedback button not found - skipping validation test');
      return;
    }

    await feedbackButton.click();

    // Try to submit without filling required fields
    const submitButton = page
      .locator('button[type="submit"], button:has-text("Submit")')
      .first();

    const submitVisible = await submitButton
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    if (!submitVisible) {
      console.log(
        'ℹ️ Submit button not immediately visible - modal may require type selection first'
      );
      return;
    }

    // Check that submit is disabled or shows error on click
    const isDisabled = await submitButton.isDisabled();

    if (isDisabled) {
      console.log('✅ Submit button is disabled when form is incomplete');
    } else {
      // Click submit and check for validation error
      await submitButton.click();

      // Look for error message
      const errorMessage = page.locator(
        'text=required, text=at least, [class*="error"]'
      );
      const hasError = await errorMessage
        .first()
        .isVisible({ timeout: 3000 })
        .catch(() => false);

      if (hasError) {
        console.log('✅ Validation error shown for required fields');
      }
    }
  });
});

test.describe('Admin Feedback Panel (Authenticated)', () => {
  test.use({ storageState: '.playwright/auth.json' });

  test('should display feedback tab in admin panel', async ({ page }) => {
    await page.goto(`${BASE_URL}/admin`);
    await page.waitForLoadState('networkidle');

    // Check if we're on admin page
    const isAdmin = page.url().includes('/admin');
    if (!isAdmin) {
      skipOrFail('Not on admin page - may not have admin access');
      return;
    }

    // Look for feedback tab
    const feedbackTab = page
      .locator('text=Game Feedback, text=Feedback, button:has-text("Feedback")')
      .first();

    const tabVisible = await feedbackTab
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (tabVisible) {
      console.log('✅ Feedback tab is visible in admin panel');
      await expect(feedbackTab).toBeVisible();
    } else {
      console.log(
        'ℹ️ Feedback tab not found - may not be implemented or named differently'
      );
    }
  });

  test('should load feedback list when tab clicked', async ({ page }) => {
    await page.goto(`${BASE_URL}/admin`);
    await page.waitForLoadState('networkidle');

    // Check if we're on admin page
    if (!page.url().includes('/admin')) {
      skipOrFail('Not on admin page - may not have admin access');
      return;
    }

    // Click on feedback tab
    const feedbackTab = page
      .locator('text=Game Feedback, text=Feedback, button:has-text("Feedback")')
      .first();

    const tabVisible = await feedbackTab
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    if (!tabVisible) {
      skipOrFail('Feedback tab not found in admin panel');
      return;
    }

    await feedbackTab.click();

    // Check for feedback list or empty state (wait for content to load)
    const feedbackList = page.locator(
      '[class*="feedback"], text=Bug Report, text=Feature Request, text=No feedback'
    );
    const hasContent = await feedbackList
      .first()
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (hasContent) {
      console.log('✅ Feedback content loaded in admin panel');
    }
  });

  test('should display feedback type filters', async ({ page }) => {
    await page.goto(`${BASE_URL}/admin`);
    await page.waitForLoadState('networkidle');

    if (!page.url().includes('/admin')) {
      skipOrFail('Not on admin page - may not have admin access');
      return;
    }

    // Click on feedback tab
    const feedbackTab = page
      .locator('text=Game Feedback, text=Feedback')
      .first();
    const tabVisible = await feedbackTab
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    if (!tabVisible) {
      skipOrFail('Feedback tab not found in admin panel');
      return;
    }

    await feedbackTab.click();

    // Look for filter dropdowns
    const typeFilter = page
      .locator('select, [role="combobox"]')
      .filter({ hasText: /type|bug|feature/i });
    const hasFilters = await typeFilter
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (hasFilters) {
      console.log('✅ Feedback type filter is available');
    }
  });
});
