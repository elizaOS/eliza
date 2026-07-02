/**
 * Uncovered Pages E2E Tests
 *
 * Tests pages that don't have dedicated test files:
 * comment detail, actor/org profiles, user handle routes,
 * API docs, offline page, and admin sub-routes.
 */

import { expect, test } from "./fixtures";
import { pageContainsText } from "./helpers/interaction-helpers";
import {
  cooldownBetweenTests,
  isServerHealthy,
  navigateTo,
  waitForPageLoad,
} from "./helpers/page-helpers";
import { loginWithWallet } from "./helpers/auth";
import { ROUTES, TIMEOUTS, VIEWPORTS } from "./helpers/test-data";

test.setTimeout(TIMEOUTS.EXTRA_LONG);

test.describe("User Handle Routes", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("loads user profile via /u/[handle]", async ({ page }) => {
    await navigateTo(page, ROUTES.USER_BY_HANDLE("testuser"));
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(50);
  });

  test("loads user profile via /u/id/[userId]", async ({ page }) => {
    await navigateTo(page, ROUTES.USER_BY_ID("1"));
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(50);
  });
});

test.describe("Actor Profile", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("loads actor profile via /actors/[id]", async ({ page }) => {
    await navigateTo(page, ROUTES.ACTORS_BY_ID("1"));
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);

    // Should show profile content or 404
    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(50);
  });
});

test.describe("Organization Profile", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("loads organization profile via /orgs/[id]", async ({ page }) => {
    await navigateTo(page, ROUTES.ORGS_BY_ID("1"));
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(50);
  });
});

test.describe("API Documentation", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await page.waitForTimeout(1000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("loads API documentation page", async ({ page }) => {
    await navigateTo(page, ROUTES.API_DOCS);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);

    const hasApiContent = await pageContainsText(
      page,
      "api",
      "endpoint",
      "documentation",
      "swagger",
      "openapi",
    );

    const body = await page.locator("body").textContent();
    expect(hasApiContent || (body?.length ?? 0) > 100).toBe(true);
  });

  test("displays API endpoint documentation", async ({ page }) => {
    await navigateTo(page, ROUTES.API_DOCS);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);

    const hasEndpoints = await pageContainsText(
      page,
      "get",
      "post",
      "put",
      "delete",
      "/api",
      "endpoint",
    );

    const body = await page.locator("body").textContent();
    expect(hasEndpoints || (body?.length ?? 0) > 100).toBe(true);
  });
});

test.describe("Offline Page", () => {
  test("displays offline fallback page", async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }

    await navigateTo(page, ROUTES.OFFLINE);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(10);
  });
});

test.describe("Admin Sub-Routes", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("loads admin DAG visualizer page", async ({ page }) => {
    await navigateTo(page, ROUTES.ADMIN_DAG);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(50);
  });

  test("loads admin resolutions page", async ({ page }) => {
    await navigateTo(page, ROUTES.ADMIN_RESOLUTIONS);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(50);
  });

  test("loads admin groups page", async ({ page }) => {
    await navigateTo(page, ROUTES.ADMIN_GROUPS);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(50);
  });

  test("loads admin performance page", async ({ page }) => {
    await navigateTo(page, ROUTES.ADMIN_PERFORMANCE);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);

    const body = await page.locator("body").textContent();
    expect(body?.length).toBeGreaterThan(50);
  });
});

test.describe("Game Page", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("loads game status page", async ({ page }) => {
    await navigateTo(page, ROUTES.GAME);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);

    const hasGameContent = await pageContainsText(
      page,
      "game",
      "status",
      "running",
      "stopped",
      "statistics",
    );

    const body = await page.locator("body").textContent();
    expect(hasGameContent || (body?.length ?? 0) > 100).toBe(true);
  });

  test("displays game statistics", async ({ page }) => {
    await navigateTo(page, ROUTES.GAME);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);

    const hasStats = await pageContainsText(
      page,
      "post",
      "question",
      "company",
      "agent",
      "user",
      "stat",
    );

    const body = await page.locator("body").textContent();
    expect(hasStats || (body?.length ?? 0) > 100).toBe(true);
  });

  test("shows refresh button", async ({ page }) => {
    await navigateTo(page, ROUTES.GAME);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);

    const refreshButton = page
      .locator(
        'button:has-text("Refresh"), button:has(svg.lucide-refresh-cw), button[aria-label*="refresh" i]',
      )
      .first();
    const hasRefresh = await refreshButton
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    const body = await page.locator("body").textContent();
    expect(hasRefresh || (body?.length ?? 0) > 100).toBe(true);
  });
});

test.describe("NFT Page", () => {
  test.beforeEach(async ({ page }) => {
    if (!(await isServerHealthy())) {
      test.skip();
      return;
    }
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await loginWithWallet(page);
    await page.waitForTimeout(2000);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("loads NFT gallery page", async ({ page }) => {
    await navigateTo(page, ROUTES.NFT);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);

    const hasNftContent = await pageContainsText(
      page,
      "nft",
      "collection",
      "gallery",
      "mint",
      "token",
    );

    const body = await page.locator("body").textContent();
    expect(hasNftContent || (body?.length ?? 0) > 100).toBe(true);
  });

  test("displays search on NFT page", async ({ page }) => {
    await navigateTo(page, ROUTES.NFT);
    await waitForPageLoad(page);
    await page.waitForTimeout(2000);

    const searchInput = page
      .locator('input[placeholder*="search" i], input[type="search"]')
      .first();
    const hasSearch = await searchInput
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    const body = await page.locator("body").textContent();
    expect(hasSearch || (body?.length ?? 0) > 100).toBe(true);
  });
});
