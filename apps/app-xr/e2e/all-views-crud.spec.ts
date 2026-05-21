/**
 * all-views-crud.spec.ts
 *
 * Playwright e2e test: verifies that all 25 registered XR view panels can be
 * opened, rendered, and closed via the agent view-host route.
 */

import { expect, test } from "@playwright/test";

const BASE_URL = process.env.XR_BASE_URL ?? "http://localhost:31337";

const ALL_VIEW_IDS = [
  "wallet",
  "companion",
  "training",
  "task-coordinator",
  "views-manager",
  "polymarket",
  "vincent",
  "steward",
  "shopify",
  "phone",
  "contacts",
  "messages",
  "feed",
  "2004scape",
  "defense-of-the-agents",
  "clawville",
  "hyperliquid",
  "hyperscape",
  "lifeops",
  "scape",
  "screenshare",
  "trajectory-logger",
  "model-tester",
  "smartglasses",
  "hearwear",
] as const;

test.describe("XR view CRUD — all 25 views", () => {
  for (const viewId of ALL_VIEW_IDS) {
    test(`view "${viewId}" — load, render, close`, async ({ page }) => {
      const url = `${BASE_URL}/api/xr/view-host/${viewId}`;
      const response = await page.goto(url);

      expect(response?.status()).toBe(200);

      // Shell must render
      await expect(page.locator("#xr-shell")).toBeVisible();

      // View id must be in the HTML
      const html = await page.content();
      expect(html).toContain(`data-view-id="${viewId}"`);

      // Title bar must show the view id
      await expect(page.locator("#xr-bar-title")).toContainText(viewId);

      // Close button must be present
      await expect(page.locator("#btn-close")).toBeVisible();

      // Clicking close should post a message (no error)
      await page.locator("#btn-close").click();
    });
  }

  test("all 25 view ids are unique", () => {
    const ids = [...ALL_VIEW_IDS];
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
    expect(ids.length).toBe(25);
  });
});
