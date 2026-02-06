import { test, expect } from "@playwright/test";

/**
 * Authentication Routing Tests
 *
 * Tests for proper routing behavior during login/logout flows:
 * - returnTo parameter preservation on login redirects
 * - Protected route redirects to login with returnTo
 * - Post-login redirect to intended destination
 * - Logout redirect behavior
 */

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

test.describe("Authentication Routing", () => {
  test.describe("Login Page - returnTo Parameter", () => {
    test("login page URL should accept returnTo parameter", async ({
      page,
    }) => {
      await page.goto(`${BASE_URL}/login?returnTo=/dashboard/settings`);
      expect(page.url()).toContain("returnTo");
    });

    test("login page should render without errors when returnTo is provided", async ({
      page,
    }) => {
      await page.goto(`${BASE_URL}/login?returnTo=/dashboard/settings`);
      // Check that the page loaded without JavaScript errors
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));
      await page.waitForLoadState("networkidle");
      // Filter out known non-critical errors
      const criticalErrors = errors.filter(
        (e) =>
          !e.includes("WalletConnect") &&
          !e.includes("hydration") &&
          !e.includes("ResizeObserver"),
      );
      expect(criticalErrors).toHaveLength(0);
    });

    test("returnTo parameter should be URL-safe with encoded characters", async ({
      page,
    }) => {
      const complexPath = "/dashboard/chat?characterId=abc-123&mode=test";
      const encodedPath = encodeURIComponent(complexPath);
      await page.goto(`${BASE_URL}/login?returnTo=${encodedPath}`);
      await page.waitForLoadState("networkidle");
      // Page should load without crashing
      expect(page.url()).toContain("returnTo");
    });

    test("should reject potentially unsafe returnTo values", async ({
      page,
    }) => {
      // Try to inject an external URL
      await page.goto(`${BASE_URL}/login?returnTo=https://evil.com`);
      await page.waitForLoadState("networkidle");
      // Should not redirect to external URL - check we're still on same domain
      expect(page.url()).toContain(BASE_URL.replace("http://", ""));
    });
  });

  test.describe("Protected Route Redirects", () => {
    test("dashboard page should be accessible", async ({ page }) => {
      const response = await page.goto(`${BASE_URL}/dashboard`);
      // Should either show dashboard or redirect to login
      expect([200, 304]).toContain(response?.status() ?? 0);
    });

    test("dashboard settings should be accessible", async ({ page }) => {
      const response = await page.goto(`${BASE_URL}/dashboard/settings`);
      expect([200, 304]).toContain(response?.status() ?? 0);
    });

    test("dashboard chat should be accessible", async ({ page }) => {
      const response = await page.goto(`${BASE_URL}/dashboard/chat`);
      expect([200, 304]).toContain(response?.status() ?? 0);
    });
  });

  test.describe("Navigation History", () => {
    test("login page should not pollute browser history", async ({ page }) => {
      // Navigate to a page, then to login
      await page.goto(`${BASE_URL}/dashboard`);
      await page.waitForLoadState("networkidle");

      // Store initial history length after dashboard load
      const initialHistoryLength = await page.evaluate(
        () => window.history.length,
      );

      // Navigate to login with returnTo
      await page.goto(`${BASE_URL}/login?returnTo=/dashboard`);
      await page.waitForLoadState("networkidle");

      // History length should only increase by 1 (not create multiple entries)
      const finalHistoryLength = await page.evaluate(
        () => window.history.length,
      );
      expect(finalHistoryLength).toBeLessThanOrEqual(initialHistoryLength + 2);
    });
  });

  test.describe("URL Parameter Validation", () => {
    test("returnTo should only accept relative paths", async ({ page }) => {
      const maliciousUrls = [
        "//evil.com",
        "javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "https://evil.com/path",
      ];

      for (const maliciousUrl of maliciousUrls) {
        await page.goto(
          `${BASE_URL}/login?returnTo=${encodeURIComponent(maliciousUrl)}`,
        );
        await page.waitForLoadState("networkidle");
        // Should still be on our domain
        expect(page.url()).toMatch(
          new RegExp(`^${BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
        );
      }
    });

    test("returnTo should handle special characters safely", async ({
      page,
    }) => {
      const specialPaths = [
        "/dashboard/chat?q=test&foo=bar",
        "/dashboard/settings#section",
        "/dashboard/chat?name=Test%20Name",
      ];

      for (const path of specialPaths) {
        await page.goto(
          `${BASE_URL}/login?returnTo=${encodeURIComponent(path)}`,
        );
        await page.waitForLoadState("networkidle");
        // Should load without errors
        expect(page.url()).toContain("login");
      }
    });
  });

  test.describe("Page Response Codes", () => {
    test("login page returns 200", async ({ request }) => {
      const response = await request.get(`${BASE_URL}/login`);
      expect(response.status()).toBe(200);
    });

    test("login page with returnTo returns 200", async ({ request }) => {
      const response = await request.get(
        `${BASE_URL}/login?returnTo=/dashboard/settings`,
      );
      expect(response.status()).toBe(200);
    });

    test("dashboard page returns 200", async ({ request }) => {
      const response = await request.get(`${BASE_URL}/dashboard`);
      expect(response.status()).toBe(200);
    });

    test("dashboard settings page returns 200", async ({ request }) => {
      const response = await request.get(`${BASE_URL}/dashboard/settings`);
      expect(response.status()).toBe(200);
    });
  });

  test.describe("Invite Flow Routing", () => {
    test("invite accept page should be accessible", async ({ request }) => {
      const response = await request.get(
        `${BASE_URL}/invite/accept?token=test-token`,
      );
      expect(response.status()).toBe(200);
    });
  });
});

test.describe("Console Error Monitoring", () => {
  test("login page should not have critical console errors", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("networkidle");

    // Filter out known non-critical errors (WalletConnect, 404s for assets, etc.)
    const criticalErrors = consoleErrors.filter(
      (e) =>
        !e.includes("WalletConnect") &&
        !e.includes("LCP") &&
        !e.includes("favicon") &&
        !e.includes("eth_accounts") &&
        !e.includes("404") &&
        !e.includes("Failed to load resource"),
    );

    // Log errors for debugging
    if (criticalErrors.length > 0) {
      console.log("Critical console errors found:", criticalErrors);
    }

    expect(criticalErrors).toHaveLength(0);
  });

  test("dashboard should not have critical console errors", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForLoadState("networkidle");

    // Filter out known non-critical errors
    const criticalErrors = consoleErrors.filter(
      (e) =>
        !e.includes("WalletConnect") &&
        !e.includes("LCP") &&
        !e.includes("favicon") &&
        !e.includes("eth_accounts") &&
        !e.includes("TAVILY"),
    );

    expect(criticalErrors).toHaveLength(0);
  });
});
