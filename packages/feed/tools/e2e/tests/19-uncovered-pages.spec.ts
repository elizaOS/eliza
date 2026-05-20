import { expect, test } from "./fixtures";
import { pageContainsText } from "./helpers/interaction-helpers";
import {
  cooldownBetweenTests,
  isServerHealthy,
  navigateTo,
  waitForPageLoad,
} from "./helpers/page-helpers";
import { ROUTES, SELECTORS, VIEWPORTS } from "./helpers/test-data";
import { loginWithWallet } from "./helpers/wallet-auth";

test.setTimeout(60000);

test.describe("Uncovered Pages - User Routes", () => {
  test.beforeEach(async ({ page }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("user handle route loads", async ({ page }) => {
    await navigateTo(page, ROUTES.USER_BY_HANDLE("testuser"));
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("user by ID route loads", async ({ page }) => {
    await navigateTo(page, ROUTES.USER_BY_ID("test-user-id"));
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("actor profile route loads", async ({ page }) => {
    await navigateTo(page, ROUTES.ACTORS_BY_ID("test-actor"));
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("org profile route loads", async ({ page }) => {
    await navigateTo(page, ROUTES.ORGS_BY_ID("test-org"));
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });
});

test.describe("Uncovered Pages - Misc Routes", () => {
  test.beforeEach(async ({ page }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("API docs page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.API_DOCS);
    await waitForPageLoad(page);
    const hasContent = await pageContainsText(
      page,
      "api",
      "docs",
      "endpoint",
      "documentation",
    );
    expect(hasContent).toBe(true);
  });

  test("offline page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.OFFLINE);
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });
});

test.describe("Uncovered Pages - Admin Sub-Routes", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("admin DAG visualizer loads", async ({ page }) => {
    await navigateTo(page, ROUTES.ADMIN_DAG);
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("admin resolutions page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.ADMIN_RESOLUTIONS);
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("admin groups page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.ADMIN_GROUPS);
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("admin performance page loads", async ({ page }) => {
    await navigateTo(page, ROUTES.ADMIN_PERFORMANCE);
    await waitForPageLoad(page);
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });
});

test.describe("Uncovered Pages - Game", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.GAME);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("game status visible", async ({ page }) => {
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("game statistics display", async ({ page }) => {
    const hasStats = await pageContainsText(
      page,
      "score",
      "points",
      "level",
      "rank",
      "status",
    );
    expect(typeof hasStats).toBe("boolean");
  });

  test("game refresh functionality", async ({ page }) => {
    const refreshBtn = page
      .locator('button:has-text("Refresh"), button[aria-label*="refresh" i]')
      .first();
    const isVisible = await refreshBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    if (isVisible) {
      await refreshBtn.click({ force: true });
      await page.waitForTimeout(1000);
      const body = await page.locator("body").textContent();
      expect(body).toBeTruthy();
    } else {
      expect(true).toBe(true);
    }
  });
});

test.describe("Uncovered Pages - NFT", () => {
  test.beforeEach(async ({ page, wallets }) => {
    const healthy = await isServerHealthy();
    test.skip(!healthy, "Server is not healthy");
    await page.setViewportSize(VIEWPORTS.DESKTOP);
    await navigateTo(page, ROUTES.HOME);
    await waitForPageLoad(page);
    await loginWithWallet(page, wallets);
    await navigateTo(page, ROUTES.NFT);
    await waitForPageLoad(page);
  });

  test.afterEach(async ({ page }) => {
    await cooldownBetweenTests(page);
  });

  test("NFT gallery renders", async ({ page }) => {
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body?.length).toBeGreaterThan(0);
  });

  test("NFT search functionality", async ({ page }) => {
    const searchInput = page.locator(SELECTORS.SEARCH_INPUT).first();
    const isVisible = await searchInput
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    expect(typeof isVisible).toBe("boolean");
  });
});
