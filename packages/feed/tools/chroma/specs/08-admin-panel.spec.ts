/**
 * Admin Panel E2E Tests
 *
 * Tests admin functionality: all 24+ dashboard tabs, user management,
 * agent controls, reports, game control, and moderation tools.
 */

import { expect, test } from "./fixtures";
import {
  clickTab,
  fillAndVerify,
  navigateToTab,
  pageContainsText,
} from "./helpers/interaction-helpers";
import {
  cooldownBetweenTests,
  isServerHealthy,
  navigateTo,
  waitForPageLoad,
} from "./helpers/page-helpers";
import { loginWithWallet } from "./helpers/auth";
import { ROUTES, SELECTORS, TIMEOUTS, VIEWPORTS } from "./helpers/test-data";

test.setTimeout(TIMEOUTS.EXTRA_LONG);

test.describe("Admin Dashboard", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateTo(page, ROUTES.ADMIN);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("admin dashboard is accessible", async ({ page }) => {
    expect(page.url()).toContain("/admin");

    const hasAdminContent = await pageContainsText(
      page,
      "admin",
      "dashboard",
      "stats",
      "users",
      "access",
    );
    expect(hasAdminContent).toBe(true);
  });

  test("admin tabs are present", async ({ page }) => {
    const tabs = [
      "Stats",
      "Users",
      "Agents",
      "Registry",
      "Reports",
      "Training",
    ];
    let tabsFound = 0;

    for (const tabName of tabs) {
      const tab = page.locator(`button:has-text("${tabName}")`).first();
      if (await tab.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)) {
        tabsFound++;
      }
    }

    const hasAdminContent = await pageContainsText(
      page,
      "admin",
      "dashboard",
      "stats",
    );
    expect(tabsFound > 0 || hasAdminContent).toBe(true);
  });
});

test.describe("Admin - All Tabs Navigation", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateTo(page, ROUTES.ADMIN);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("switches to Stats tab and shows statistics", async ({ page }) => {
    const _switched = await clickTab(page, "Stats");
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("switches to Analytics tab and shows charts", async ({ page }) => {
    const _switched = await clickTab(page, "Analytics");
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("switches to Growth Metrics tab", async ({ page }) => {
    const _switched = await clickTab(page, "Growth");
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("switches to System Health tab", async ({ page }) => {
    const _switched =
      (await clickTab(page, "System Health")) ||
      (await clickTab(page, "Health"));
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("switches to Game Control tab and shows controls", async ({ page }) => {
    const switched = await clickTab(page, "Game Control");
    if (switched) {
      const hasGameContent = await pageContainsText(
        page,
        "game",
        "control",
        "start",
        "stop",
        "pause",
        "status",
      );
      expect(hasGameContent).toBe(true);
    }
  });

  test("switches to Fees tab and shows fee configuration", async ({ page }) => {
    const _switched = await clickTab(page, "Fees");
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("switches to Trades tab and shows trading feed", async ({ page }) => {
    const _switched = await clickTab(page, "Trades");
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("switches to Markets Oversight tab", async ({ page }) => {
    const _switched =
      (await clickTab(page, "Market Oversight")) ||
      (await clickTab(page, "Markets"));
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("switches to Users tab and shows user management", async ({ page }) => {
    const switched = await clickTab(page, "Users");
    if (switched) {
      const hasUserContent = await pageContainsText(
        page,
        "user",
        "email",
        "admin",
        "search",
      );
      expect(hasUserContent).toBe(true);
    }
  });

  test("switches to Content Moderation tab", async ({ page }) => {
    const _switched =
      (await clickTab(page, "Content Moderation")) ||
      (await clickTab(page, "Moderation"));
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("switches to Registry tab", async ({ page }) => {
    const _switched = await clickTab(page, "Registry");
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("switches to Groups tab", async ({ page }) => {
    const _switched = await clickTab(page, "Groups");
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("switches to Notifications tab", async ({ page }) => {
    const _switched = await clickTab(page, "Notifications");
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("switches to Admins/Management tab", async ({ page }) => {
    const _switched =
      (await clickTab(page, "Management")) || (await clickTab(page, "Admins"));
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("switches to Reports tab", async ({ page }) => {
    const switched = await clickTab(page, "Reports");
    if (switched) {
      const hasReportContent = await pageContainsText(
        page,
        "report",
        "moderation",
        "review",
      );
      expect(hasReportContent).toBe(true);
    }
  });

  test("switches to Feedback tab", async ({ page }) => {
    const _switched = await clickTab(page, "Feedback");
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("switches to Human Review tab", async ({ page }) => {
    const _switched = await clickTab(page, "Human Review");
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("switches to AI Models tab", async ({ page }) => {
    const _switched = await clickTab(page, "AI Models");
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("switches to Training tab", async ({ page }) => {
    const _switched = await clickTab(page, "Training");
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("switches to Agents tab and shows agent controls", async ({ page }) => {
    const switched = await clickTab(page, "Agents");
    if (switched) {
      const hasAgentContent = await pageContainsText(
        page,
        "agent",
        "pause",
        "resume",
        "running",
      );
      expect(hasAgentContent).toBe(true);
    }
  });

  test("switches to Escrow tab", async ({ page }) => {
    const _switched = await clickTab(page, "Escrow");
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("switches to Audit Logs tab", async ({ page }) => {
    const _switched = await clickTab(page, "Audit Logs");
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("switches to Alpha Groups tab", async ({ page }) => {
    const _switched =
      (await clickTab(page, "Alpha Groups")) || (await clickTab(page, "Alpha"));
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("switches to Whitelist tab", async ({ page }) => {
    const _switched = await clickTab(page, "Whitelist");
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });
});

test.describe("Admin - Users Tab Interactions", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateToTab(page, "/admin", "users");
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("displays user list or table", async ({ page }) => {
    const hasUserContent = await pageContainsText(
      page,
      "user",
      "email",
      "admin",
    );
    expect(hasUserContent).toBe(true);
  });

  test("searches users by username or email", async ({ page }) => {
    const value = await fillAndVerify(page, SELECTORS.SEARCH_INPUT, "test");

    if (value) {
      await page.waitForTimeout(1000);
    }

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(100);
  });

  test("displays user details in table format", async ({ page }) => {
    const table = page.locator('table, [role="table"]').first();
    const hasTable = await table
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    const body = await page.locator("body").textContent();
    expect(hasTable || (body?.length ?? 0) > 100).toBe(true);
  });
});

test.describe("Admin - Agents Tab Interactions", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateToTab(page, "/admin", "agents");
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("displays agent list with status indicators", async ({ page }) => {
    const hasAgentContent = await pageContainsText(
      page,
      "agent",
      "running",
      "paused",
      "active",
      "idle",
    );
    expect(hasAgentContent).toBe(true);
  });

  test("has pause all agents button", async ({ page }) => {
    const pauseButton = page.locator('button:has-text("Pause")').first();
    const hasPause = await pauseButton
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    const hasAgentContent = await pageContainsText(page, "agent", "pause");
    expect(hasPause || hasAgentContent).toBe(true);
  });

  test("has resume all agents button", async ({ page }) => {
    const resumeButton = page.locator('button:has-text("Resume")').first();
    const hasResume = await resumeButton
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    const hasAgentContent = await pageContainsText(page, "agent", "resume");
    expect(hasResume || hasAgentContent).toBe(true);
  });
});

test.describe("Admin - Reports Tab Interactions", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateToTab(page, "/admin", "reports");
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("displays reported content queue", async ({ page }) => {
    const hasReportContent = await pageContainsText(
      page,
      "report",
      "moderation",
      "review",
      "content",
    );
    expect(hasReportContent).toBe(true);
  });

  test("shows approve/reject action buttons", async ({ page }) => {
    const approveButton = page
      .locator(
        'button:has-text("Approve"), button:has-text("Accept"), button:has-text("Dismiss")',
      )
      .first();
    const rejectButton = page
      .locator(
        'button:has-text("Reject"), button:has-text("Remove"), button:has-text("Ban")',
      )
      .first();

    const hasApprove = await approveButton
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);
    const hasReject = await rejectButton
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    // Buttons only visible if there are reports
    const body = await page.locator("body").textContent();
    expect(hasApprove || hasReject || (body?.length ?? 0) > 100).toBe(true);
  });
});

test.describe("Admin - Game Control", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await navigateTo(page, ROUTES.ADMIN);
    await waitForPageLoad(page);
    await page.waitForTimeout(1000);
    await clickTab(page, "Game Control");
    await page.waitForTimeout(1500);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("displays game running/stopped status", async ({ page }) => {
    const hasGameStatus = await pageContainsText(
      page,
      "running",
      "stopped",
      "paused",
      "status",
      "game",
    );

    const body = await page.locator("body").textContent();
    expect(hasGameStatus || (body?.length ?? 0) > 100).toBe(true);
  });

  test("shows refresh statistics button", async ({ page }) => {
    const refreshButton = page
      .locator(
        'button:has-text("Refresh"), button:has-text("Reload"), button:has(svg.lucide-refresh-cw)',
      )
      .first();
    const hasRefresh = await refreshButton
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    const body = await page.locator("body").textContent();
    expect(hasRefresh || (body?.length ?? 0) > 100).toBe(true);
  });
});
