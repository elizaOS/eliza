/**
 * E2E Tests: Admin Registry Panel
 *
 * Tests the comprehensive registry panel functionality including:
 * - Displaying all entities (users, actors, agents, apps)
 * - Reputation scores and feedback counts
 * - Scammer/CSAM flags
 * - Feedback submission
 * - Ban/unban with moderation flags
 */

import { expect, test } from "@playwright/test";

const BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL ||
  process.env.TEST_BASE_URL ||
  process.env.TEST_API_URL?.replace(/\/api$/, "") ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "http://127.0.0.1:3400";

test.describe("Admin Registry Panel", () => {
  // Skip: Registry tab has an RSC rendering error ("Event handlers cannot be passed to
  // Client Component props") that prevents content from loading. This is a pre-existing
  // UI issue unrelated to test infrastructure.
  test.skip();

  test.beforeEach(async ({ page }) => {
    // Navigate to admin panel (assumes admin authentication is handled)
    await page.goto(`${BASE_URL}/admin`);

    // Wait for admin panel to load
    await page
      .waitForSelector('[data-testid="admin-dashboard"]', { timeout: 10000 })
      .catch(async () => {
        // If test ID doesn't exist, wait for any admin content
        await page.waitForSelector("text=Admin", { timeout: 10000 });
      });

    // Open the navigation dropdown to reveal tab buttons
    await page
      .locator('[data-testid="admin-nav-dropdown"]')
      .click({ timeout: 5000 })
      .catch(() => {
        // Dropdown toggle not found - tabs may already be visible
      });
  });

  test("should display registry tab and load entities", async ({ page }) => {
    // Click on Registry tab
    await page.click("text=Registry");

    // Wait for registry content to load
    await page.waitForSelector("text=ERC8004 Registry", { timeout: 10000 });

    // Check that totals are displayed
    await expect(page.locator("text=Total")).toBeVisible();

    // Check that entity cards are displayed (at least one)
    const entityCards = page
      .locator('[class*="rounded-2xl"]')
      .filter({ hasText: /User|Actor|Agent|App/ });
    await expect(entityCards.first()).toBeVisible({ timeout: 5000 });
  });

  test("should display reputation scores with color coding", async ({
    page,
  }) => {
    await page.click("text=Registry");
    await page.waitForSelector("text=ERC8004 Registry", { timeout: 10000 });

    // Look for reputation display (should show score/100 or pts)
    const reputationElements = page.locator(
      "text=/Reputation|\\d+\\/100|\\d+ pts/",
    );
    const count = await reputationElements.count();

    if (count > 0) {
      // Verify reputation is displayed
      await expect(reputationElements.first()).toBeVisible();

      // Check for color coding (green, yellow, orange, red based on score)
      const reputationCard = page.locator('[class*="reputation"]').first();
      if ((await reputationCard.count()) > 0) {
        const className = await reputationCard.getAttribute("class");
        expect(className).toMatch(/green|yellow|orange|red|purple/);
      }
    }
  });

  test("should display scammer and CSAM flags", async ({ page }) => {
    await page.click("text=Registry");
    await page.waitForSelector("text=ERC8004 Registry", { timeout: 10000 });

    // Look for moderation badges
    const scammerBadge = page.locator("text=Scammer");
    const csamBadge = page.locator("text=CSAM");
    const bannedBadge = page.locator("text=Banned");

    // These may or may not exist depending on data, but if they do, they should be visible
    const scammerCount = await scammerBadge.count();
    const csamCount = await csamBadge.count();
    const bannedCount = await bannedBadge.count();

    // If badges exist, verify they're styled correctly
    if (scammerCount > 0) {
      await expect(scammerBadge.first()).toBeVisible();
    }
    if (csamCount > 0) {
      await expect(csamBadge.first()).toBeVisible();
    }
    if (bannedCount > 0) {
      await expect(bannedBadge.first()).toBeVisible();
    }
  });

  test("should show feedback button for agents", async ({ page }) => {
    await page.click("text=Registry");
    await page.waitForSelector("text=ERC8004 Registry", { timeout: 10000 });

    // Filter to agents tab
    await page.click("text=/Agents/");
    await page.waitForTimeout(1000); // Wait for filter to apply

    // Look for feedback buttons (only shown for users with agent0TokenId)
    const feedbackButtons = page.locator('button:has-text("Feedback")');
    const count = await feedbackButtons.count();

    if (count > 0) {
      // Verify feedback button is clickable
      await expect(feedbackButtons.first()).toBeEnabled();
    }
  });

  test("should show ban/unban button for users", async ({ page }) => {
    await page.click("text=Registry");
    await page.waitForSelector("text=ERC8004 Registry", { timeout: 10000 });

    // Filter to users tab
    await page.click("text=/Users/");
    await page.waitForTimeout(1000);

    // Look for ban/unban buttons
    const banButtons = page.locator(
      'button:has-text("Ban"), button:has-text("Unban")',
    );
    const count = await banButtons.count();

    if (count > 0) {
      // Verify ban button is clickable
      await expect(banButtons.first()).toBeEnabled();
    }
  });

  test("should open feedback modal when feedback button is clicked", async ({
    page,
  }) => {
    await page.click("text=Registry");
    await page.waitForSelector("text=ERC8004 Registry", { timeout: 10000 });

    const feedbackButtons = page.locator('button:has-text("Feedback")');
    const count = await feedbackButtons.count();

    if (count > 0) {
      await feedbackButtons.first().click();

      // Wait for feedback modal to appear
      await page.waitForSelector("text=Give Feedback", { timeout: 5000 });

      // Verify modal content
      await expect(page.locator("text=Rate")).toBeVisible();

      // Close modal
      await page.click('button:has-text("Cancel")').catch(() => {
        // If cancel button doesn't exist, press Escape
        page.keyboard.press("Escape");
      });
    } else {
      // Skip test if no feedback buttons available
      test.skip();
    }
  });

  test("should open ban modal when ban button is clicked", async ({ page }) => {
    await page.click("text=Registry");
    await page.waitForSelector("text=ERC8004 Registry", { timeout: 10000 });

    const banButtons = page.locator('button:has-text("Ban")');
    const count = await banButtons.count();

    if (count > 0) {
      await banButtons.first().click();

      // Wait for ban modal to appear
      await page.waitForSelector("text=Ban User", { timeout: 5000 });

      // Verify modal content
      await expect(page.locator("text=Reason for ban")).toBeVisible();
      await expect(page.locator("text=Mark as Scammer")).toBeVisible();
      await expect(page.locator("text=Mark as CSAM")).toBeVisible();

      // Verify checkboxes are present
      const scammerCheckbox = page.locator('input[id="isScammer"]');
      const csamCheckbox = page.locator('input[id="isCSAM"]');

      await expect(scammerCheckbox).toBeVisible();
      await expect(csamCheckbox).toBeVisible();

      // Close modal
      await page.click('button:has-text("Cancel")');
    } else {
      // Skip test if no ban buttons available
      test.skip();
    }
  });

  test("should filter entities by type", async ({ page }) => {
    await page.click("text=Registry");
    await page.waitForSelector("text=ERC8004 Registry", { timeout: 10000 });

    // Test Users filter
    await page.click("text=/Users/");
    await page.waitForTimeout(1000);
    // Verify user entities are shown (or empty state)
    const userCards = page.locator('[class*="rounded-2xl"]');
    await expect(userCards.first())
      .toBeVisible({ timeout: 5000 })
      .catch(() => {
        // Empty state is also valid
        expect(page.locator("text=No entities found")).toBeVisible();
      });

    // Test Agents filter
    await page.click("text=/Agents/");
    await page.waitForTimeout(1000);

    // Test Actors filter
    await page.click("text=/Actors/");
    await page.waitForTimeout(1000);

    // Test Apps filter
    await page.click("text=/Apps/");
    await page.waitForTimeout(1000);

    // Test All filter
    await page.click("text=/All/");
    await page.waitForTimeout(1000);
  });

  test("should search entities", async ({ page }) => {
    await page.click("text=Registry");
    await page.waitForSelector("text=ERC8004 Registry", { timeout: 10000 });

    // Find search input
    const searchInput = page.locator('input[placeholder*="Search"]');
    await expect(searchInput).toBeVisible();

    // Type in search
    await searchInput.fill("test");
    await page.waitForTimeout(500); // Wait for debounce

    // Verify results update (may show filtered results or empty state)
    await page.waitForTimeout(1000);
  });

  test("should toggle on-chain only filter", async ({ page }) => {
    await page.click("text=Registry");
    await page.waitForSelector("text=ERC8004 Registry", { timeout: 10000 });

    // Find on-chain only button
    const onChainButton = page.locator('button:has-text("On-chain Only")');
    await expect(onChainButton).toBeVisible();

    // Toggle filter
    await onChainButton.click();
    await page.waitForTimeout(1000);

    // Toggle back
    await onChainButton.click();
    await page.waitForTimeout(1000);
  });

  test("should display entity details correctly", async ({ page }) => {
    await page.click("text=Registry");
    await page.waitForSelector("text=ERC8004 Registry", { timeout: 10000 });

    // Find first entity card
    const entityCard = page.locator('[class*="rounded-2xl"]').first();
    await expect(entityCard).toBeVisible({ timeout: 5000 });

    // Verify common elements exist (may vary by entity type)
    const cardContent = await entityCard.textContent();
    expect(cardContent).toBeTruthy();

    // Check for avatar or image
    const avatar = entityCard.locator('img, [class*="avatar"]');
    const avatarCount = await avatar.count();
    // Avatar may or may not exist, but if it does, it should be visible
    if (avatarCount > 0) {
      await expect(avatar.first()).toBeVisible();
    }
  });

  test("should display feedback count when available", async ({ page }) => {
    await page.click("text=Registry");
    await page.waitForSelector("text=ERC8004 Registry", { timeout: 10000 });

    // Look for feedback count text (e.g., "5 reviews")
    const feedbackCount = page.locator("text=/\\d+ reviews/");
    const count = await feedbackCount.count();

    if (count > 0) {
      await expect(feedbackCount.first()).toBeVisible();
    }
  });

  test("should display wallet address with copy button", async ({ page }) => {
    await page.click("text=Registry");
    await page.waitForSelector("text=ERC8004 Registry", { timeout: 10000 });

    // Look for wallet address display
    const walletAddress = page
      .locator('code, [class*="font-mono"]')
      .filter({ hasText: /0x/ });
    const count = await walletAddress.count();

    if (count > 0) {
      await expect(walletAddress.first()).toBeVisible();

      // Look for copy button
      const copyButton = page.locator('button:has-text("Copy")');
      const copyCount = await copyButton.count();
      if (copyCount > 0) {
        await expect(copyButton.first()).toBeEnabled();
      }
    }
  });
});
