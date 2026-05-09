import { expect, type Page, test } from "@playwright/test";

/**
 * UUID Sanitization E2E Tests
 *
 * Tests for proper handling of malformed UUIDs in URL parameters:
 * - Dashboard chat page should handle invalid characterId gracefully
 * - Should not crash with trailing backslash (URL-encoded %5C)
 * - Should not return 500 errors for malformed UUIDs
 *
 * These tests verify the fix for the production error:
 * "invalid input syntax for type uuid: 17c8b876-86a0-465d-9794-2aea244f4239\"
 */

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

async function gotoDashboardChat(page: Page, search: string) {
  const response = await page.goto(`${BASE_URL}/dashboard/chat${search}`, {
    waitUntil: "domcontentloaded",
  });

  await expect(page.locator("body")).toContainText(/New chat|Model Playground|Meet Agent\.Pro/);

  return response;
}

test.describe("UUID Sanitization - Dashboard Chat", () => {
  test.describe("Malformed characterId Handling", () => {
    test("dashboard chat handles characterId with trailing backslash", async ({ page }) => {
      // This is the exact pattern from production error logs
      // URL: ?characterId=17c8b876-86a0-465d-9794-2aea244f4239%5C
      const malformedId = "17c8b876-86a0-465d-9794-2aea244f4239%5C"; // %5C = backslash

      const response = await gotoDashboardChat(page, `?characterId=${malformedId}`);

      // Should NOT return 500 (the original bug)
      expect(response?.status()).not.toBe(500);

      // Should return 200 (page loads, just without the character)
      expect(response?.status()).toBe(200);
    });

    test("dashboard chat handles characterId with double backslash", async ({ page }) => {
      const malformedId = "17c8b876-86a0-465d-9794-2aea244f4239%5C%5C";

      const response = await gotoDashboardChat(page, `?characterId=${malformedId}`);

      expect(response?.status()).not.toBe(500);
      expect(response?.status()).toBe(200);
    });

    test("dashboard chat handles characterId with trailing forward slash", async ({ page }) => {
      const malformedId = "17c8b876-86a0-465d-9794-2aea244f4239%2F"; // %2F = forward slash

      const response = await gotoDashboardChat(page, `?characterId=${malformedId}`);

      expect(response?.status()).not.toBe(500);
      expect(response?.status()).toBe(200);
    });

    test("dashboard chat handles completely invalid characterId", async ({ page }) => {
      const response = await gotoDashboardChat(page, "?characterId=not-a-valid-uuid");

      expect(response?.status()).not.toBe(500);
      expect(response?.status()).toBe(200);
    });

    test("dashboard chat handles empty characterId", async ({ page }) => {
      const response = await gotoDashboardChat(page, "?characterId=");

      expect(response?.status()).toBe(200);
    });

    test("dashboard chat works with valid characterId format", async ({ page }) => {
      // Valid UUID that likely doesn't exist - should still not 500
      const validUuid = "00000000-0000-4000-8000-000000000000";

      const response = await gotoDashboardChat(page, `?characterId=${validUuid}`);

      expect(response?.status()).not.toBe(500);
      expect(response?.status()).toBe(200);
    });
  });

  test.describe("Malformed roomId Handling", () => {
    test("dashboard chat handles roomId with trailing backslash", async ({ page }) => {
      const malformedId = "17c8b876-86a0-465d-9794-2aea244f4239%5C";

      const response = await gotoDashboardChat(page, `?roomId=${malformedId}`);

      expect(response?.status()).not.toBe(500);
      expect(response?.status()).toBe(200);
    });

    test("dashboard chat handles invalid roomId", async ({ page }) => {
      const response = await gotoDashboardChat(page, "?roomId=invalid-room-id");

      expect(response?.status()).not.toBe(500);
      expect(response?.status()).toBe(200);
    });
  });

  test.describe("No Console Errors on Malformed Input", () => {
    test("no critical JS errors with malformed characterId", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));

      const malformedId = "17c8b876-86a0-465d-9794-2aea244f4239%5C";
      await gotoDashboardChat(page, `?characterId=${malformedId}`);
      await page.waitForTimeout(500);

      // Filter out known non-critical errors
      const criticalErrors = errors.filter(
        (e) =>
          !e.includes("WalletConnect") &&
          !e.includes("hydration") &&
          !e.includes("ResizeObserver") &&
          !e.includes("eth_accounts"),
      );

      // Should not have any critical JavaScript errors
      expect(criticalErrors).toHaveLength(0);
    });
  });

  test.describe("SQL Injection Prevention", () => {
    test("dashboard chat safely handles SQL-like characterId", async ({ page }) => {
      // Attempt SQL injection via characterId parameter
      const maliciousId = "'; DROP TABLE users; --";

      const response = await gotoDashboardChat(
        page,
        `?characterId=${encodeURIComponent(maliciousId)}`,
      );

      // Should not return 500 (SQL error)
      expect(response?.status()).not.toBe(500);
      expect(response?.status()).toBe(200);
    });

    test("dashboard chat safely handles unicode in characterId", async ({ page }) => {
      const unicodeId = "test-id-\u0000-null-byte";

      const response = await gotoDashboardChat(
        page,
        `?characterId=${encodeURIComponent(unicodeId)}`,
      );

      expect(response?.status()).not.toBe(500);
    });
  });
});

test.describe("UUID Sanitization - API Response", () => {
  test("MCP registry API returns 200", async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/mcp/registry`);
    expect(response.status()).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty("registry");
  });

  test("MCP registry shows eliza-platform as live", async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/mcp/registry`);
    const data = await response.json();

    const elizaPlatform = data.registry.find(
      (entry: { id: string }) => entry.id === "eliza-platform",
    );

    expect(elizaPlatform).toBeDefined();
    expect(elizaPlatform.status).toBe("live");
  });
});
