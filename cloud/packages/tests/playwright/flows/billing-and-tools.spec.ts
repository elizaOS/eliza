import { expect, test } from "@playwright/test";

/**
 * Billing & API Key Flow E2E Tests
 *
 * Tests dashboard billing and API key pages load and are interactive.
 */

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

test.describe("Billing Flow", () => {
  test("billing page loads without errors", async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/dashboard/billing`);
    expect(response?.status()).not.toBe(500);
    expect([200, 302, 304]).toContain(response?.status() ?? 0);
  });

  test("billing success page loads", async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/dashboard/billing/success`);
    expect(response?.status()).not.toBe(500);
  });

  test("earnings page loads", async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/dashboard/earnings`);
    expect(response?.status()).not.toBe(500);
  });
});

test.describe("API Key Management Flow", () => {
  test("api-keys page loads without errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    const response = await page.goto(`${BASE_URL}/dashboard/api-keys`);
    expect(response?.status()).not.toBe(500);
    expect([200, 302, 304]).toContain(response?.status() ?? 0);

    await page.waitForLoadState("domcontentloaded");

    const criticalErrors = errors.filter(
      (e) =>
        !e.includes("WalletConnect") && !e.includes("hydration") && !e.includes("ResizeObserver"),
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test("api-explorer page loads without errors", async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/dashboard/api-explorer`);
    expect(response?.status()).not.toBe(500);
    expect([200, 302, 304]).toContain(response?.status() ?? 0);
  });
});

test.describe("App Chater Flow", () => {
  test("apps list page loads", async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/dashboard/apps`);
    expect(response?.status()).not.toBe(500);
  });

  test("app create page loads", async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/dashboard/apps/create`);
    expect(response?.status()).not.toBe(500);
  });
});

test.describe("Knowledge & MCP Flow", () => {
  test("documents page loads", async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/dashboard/documents`);
    expect(response?.status()).not.toBe(500);
  });

  test("MCPs page loads", async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/dashboard/mcps`);
    expect(response?.status()).not.toBe(500);
  });
});
