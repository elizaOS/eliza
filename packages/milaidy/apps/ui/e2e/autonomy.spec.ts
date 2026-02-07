import { test, expect } from "@playwright/test";
import { mockApi } from "./helpers";

test.describe("Autonomy toggle", () => {
  test("autonomy checkbox is visible in header", async ({ page }) => {
    await mockApi(page);
    await page.goto("/chat");
    await expect(page.locator("[data-action='autonomy-toggle']")).toBeVisible();
  });

  test("autonomy is unchecked by default", async ({ page }) => {
    await mockApi(page, { autonomyEnabled: false });
    await page.goto("/chat");
    await expect(page.locator("[data-action='autonomy-toggle']")).not.toBeChecked();
  });

  test("autonomy can be enabled by clicking", async ({ page }) => {
    await mockApi(page, { autonomyEnabled: false });
    await page.goto("/chat");

    const requestPromise = page.waitForRequest((req) =>
      req.url().includes("/api/agent/autonomy") && req.method() === "POST",
    );

    await page.locator("[data-action='autonomy-toggle']").click();

    const request = await requestPromise;
    const body = request.postDataJSON() as { enabled: boolean };
    expect(body.enabled).toBe(true);
  });

  test("autonomy label text is visible", async ({ page }) => {
    await mockApi(page);
    await page.goto("/chat");
    await expect(page.locator(".autonomy-toggle")).toContainText("Autonomy");
  });

  test("autonomy reflects initial state from API", async ({ page }) => {
    await mockApi(page, { autonomyEnabled: true });
    await page.goto("/chat");
    // The toggle should load as checked
    // Note: the API GET call happens on init
    await expect(page.locator("[data-action='autonomy-toggle']")).toBeChecked();
  });
});
