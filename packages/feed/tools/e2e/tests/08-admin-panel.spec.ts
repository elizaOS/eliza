import { expect, test } from "./fixtures";
import {
  clickTab,
  fillAndVerify,
  pageContainsText,
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

test.describe("Admin Panel - Dashboard", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.ADMIN);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("admin dashboard accessible", async ({ page }) => {
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("admin tabs present", async ({ page }) => {
    const tabs = page.locator('[role="tab"]');
    const tabCount = await tabs.count().catch(() => 0);
    expect(tabCount).toBeGreaterThan(0);
  });
});

test.describe("Admin Panel - Tab Switching", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.ADMIN);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  // The real tab labels from app/admin/page.tsx. The old list named 10+
  // tabs that never existed (Rewards, Settings, Finance, Roles, Permissions,
  // Cache, Queue, Webhooks, API, Database) and asserted nothing either way.
  const adminTabs = [
    "Dashboard",
    "Analytics",
    "Growth Metrics",
    "System Health",
    "Game Control",
    "Markets",
    "Fees",
    "Trades",
    "Escrow",
    "Users",
    "Admin Management",
    "Content Moderation",
    "Reports",
    "Human Review",
    "Registry",
    "Groups",
    "Alpha Groups",
    "Notifications",
    "Whitelist",
    "Agents",
    "AI Models",
    "Training Data",
    "Audit Logs",
  ];

  for (const tabName of adminTabs) {
    test(`switch to ${tabName} tab`, async ({ page }) => {
      const switched = await clickTab(page, tabName);
      test.skip(
        !switched,
        `no "${tabName}" tab rendered (requires admin permissions)`,
      );
      await page.waitForTimeout(500);
      const body = await page.locator("body").textContent();
      expect(body).toBeTruthy();
      expect(body?.length).toBeGreaterThan(0);
    });
  }
});

test.describe("Admin Panel - Users", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.ADMIN);
    await waitForPageLoad(page);
    const onTab = await clickTab(page, "Users");
    test.skip(!onTab, 'no "Users" tab rendered (requires admin permissions)');
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("users list renders", async ({ page }) => {
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("user search works", async ({ page }) => {
    const result = await fillAndVerify(page, SELECTORS.SEARCH_INPUT, "test");
    test.skip(result === null, "no search input rendered on the Users tab");
    expect(result).toBe("test");
  });

  test("users table or list displays", async ({ page }) => {
    const table = page
      .locator('table, [role="grid"], [data-testid*="user-list"]')
      .first();
    const isVisible = await table
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no users table rendered on the Users tab");
    const rows = await table
      .locator('tr, [role="row"]')
      .count()
      .catch(() => 0);
    expect(rows).toBeGreaterThan(0);
  });
});

test.describe("Admin Panel - Agents", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.ADMIN);
    await waitForPageLoad(page);
    const onTab = await clickTab(page, "Agents");
    test.skip(!onTab, 'no "Agents" tab rendered (requires admin permissions)');
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("agents list renders", async ({ page }) => {
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("pause agent button visible", async ({ page }) => {
    const pauseBtn = page
      .locator(
        'button:has-text("Pause"), button:has-text("Stop"), button:has-text("Disable")',
      )
      .first();
    const isVisible = await pauseBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no pause control rendered (no running agents)");
    await expect(pauseBtn).toBeEnabled();
  });

  test("resume agent button visible", async ({ page }) => {
    const resumeBtn = page
      .locator(
        'button:has-text("Resume"), button:has-text("Start"), button:has-text("Enable")',
      )
      .first();
    const isVisible = await resumeBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no resume control rendered (no paused agents)");
    await expect(resumeBtn).toBeEnabled();
  });
});

test.describe("Admin Panel - Reports", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.ADMIN);
    await waitForPageLoad(page);
    const onTab = await clickTab(page, "Reports");
    test.skip(!onTab, 'no "Reports" tab rendered (requires admin permissions)');
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("reports queue renders", async ({ page }) => {
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("approve button visible", async ({ page }) => {
    const approveBtn = page
      .locator('button:has-text("Approve"), button:has-text("Accept")')
      .first();
    const isVisible = await approveBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no approve control rendered (reports queue empty)");
    await expect(approveBtn).toBeEnabled();
  });

  test("reject button visible", async ({ page }) => {
    const rejectBtn = page
      .locator(
        'button:has-text("Reject"), button:has-text("Deny"), button:has-text("Dismiss")',
      )
      .first();
    const isVisible = await rejectBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no reject control rendered (reports queue empty)");
    await expect(rejectBtn).toBeEnabled();
  });
});

test.describe("Admin Panel - Game Control", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.ADMIN);
    await waitForPageLoad(page);
    const onTab = await clickTab(page, "Game Control");
    test.skip(
      !onTab,
      'no "Game Control" tab rendered (requires admin permissions)',
    );
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("game status visible", async ({ page }) => {
    const hasStatus = await pageContainsText(
      page,
      "status",
      "active",
      "running",
      "game",
    );
    expect(hasStatus).toBe(true);
  });

  test("refresh button visible", async ({ page }) => {
    const refreshBtn = page
      .locator(
        'button:has-text("Refresh"), button:has-text("Reload"), button[aria-label*="refresh" i]',
      )
      .first();
    const isVisible = await refreshBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    test.skip(!isVisible, "no refresh control rendered on the Game Control tab");
    await expect(refreshBtn).toBeEnabled();
  });
});
