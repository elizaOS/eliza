import { expect, test } from "@playwright/test";

/**
 * Anonymous Chat Flow E2E Test
 *
 * Tests the complete anonymous user journey:
 * 1. Visit character page
 * 2. Chat interface loads
 * 3. Page is interactive
 */

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

test.describe("Anonymous Chat Flow", () => {
  test("landing page → chat interface loads", async ({ page }) => {
    // Visit landing page
    const landingResponse = await page.goto(`${BASE_URL}/`);
    expect(landingResponse?.status()).toBe(200);

    // Verify the page has rendered
    await page.waitForLoadState("domcontentloaded");

    // Check for main content
    const body = await page.textContent("body");
    expect(body?.length).toBeGreaterThan(0);
  });

  test("dashboard chat page loads and has chat elements", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    const response = await page.goto(`${BASE_URL}/dashboard/chat`, {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBe(200);

    await expect(
      page.getByRole("textbox", {
        name: /ask for a comparison/i,
      }),
    ).toBeVisible();

    // Allow some time for dynamic content
    await page.waitForTimeout(2000);

    const criticalErrors = errors.filter(
      (e) =>
        !e.includes("WalletConnect") && !e.includes("hydration") && !e.includes("ResizeObserver"),
    );
    expect(criticalErrors).toHaveLength(0);
  });
});
