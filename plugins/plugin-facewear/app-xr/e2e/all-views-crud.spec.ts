/**
 * all-views-crud.spec.ts
 *
 * Playwright e2e test: verifies that registered XR view panels can be opened,
 * rendered, and closed via the agent view-host route.
 */

import { type APIRequestContext, expect, test } from "@playwright/test";

const BASE_URL = process.env.XR_BASE_URL ?? "http://localhost:31337";

async function fetchRegisteredViewIds(
  request: APIRequestContext,
): Promise<string[]> {
  const response = await request.get(`${BASE_URL}/api/xr/views`);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    views?: Array<{ id?: unknown }>;
  };
  return (body.views ?? [])
    .map((view) => view.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

test.describe("XR view CRUD — registered views", () => {
  test("registered views load, render, and close", async ({
    page,
    request,
  }) => {
    const viewIds = await fetchRegisteredViewIds(request);
    expect(viewIds.length).toBeGreaterThan(0);

    for (const viewId of viewIds) {
      const url = `${BASE_URL}/api/xr/view-host/${encodeURIComponent(viewId)}`;
      const response = await page.goto(url);

      expect(response?.status()).toBe(200);

      // Shell must render and be fully painted before trace frames are captured.
      await expect(page.locator("#xr-shell")).toBeVisible();
      await page.waitForLoadState("networkidle");

      // View id must be in the HTML
      const html = await page.content();
      expect(html).toContain(`data-view-id="${viewId}"`);

      // Title bar must show the view id
      await expect(page.locator("#xr-bar-title")).toContainText(viewId);

      // Close button must be present
      await expect(page.locator("#btn-close")).toBeVisible();

      // Clicking close should post a message (no error)
      await page.locator("#btn-close").click();
    }
  });

  test("registered view ids are unique", async ({ request }) => {
    const ids = await fetchRegisteredViewIds(request);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
  });
});
