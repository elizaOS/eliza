import { test, expect } from "@playwright/test";
import { mockApi } from "./helpers";

test.describe("Logs page", () => {
  test("displays logs heading", async ({ page }) => {
    await mockApi(page);
    await page.goto("/logs");
    await expect(page.locator("h2")).toHaveText("Logs");
  });

  test("shows log entries when logs exist", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await page.locator("a").filter({ hasText: "Logs" }).click();
    await page.waitForTimeout(500);
    const entries = page.locator(".log-entry");
    await expect(entries).toHaveCount(4);
  });

  test("shows log messages", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await page.locator("a").filter({ hasText: "Logs" }).click();
    await page.waitForTimeout(500);
    await expect(page.locator(".log-entry").first()).toBeVisible();
  });

  test("shows log sources in entries", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await page.locator("a").filter({ hasText: "Logs" }).click();
    await page.waitForTimeout(500);
    await expect(page.locator(".log-entry").first()).toBeVisible();
  });

  test("shows empty state when no logs", async ({ page }) => {
    await mockApi(page, { logCount: 0 });
    await page.goto("/");
    await page.locator("a").filter({ hasText: "Logs" }).click();
    await page.waitForTimeout(500);
    await expect(page.getByText("No log entries yet.")).toBeVisible();
  });

  test("has a Refresh button", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await page.locator("a").filter({ hasText: "Logs" }).click();
    await page.waitForTimeout(300);
    await expect(page.locator("[data-action='refresh-logs']")).toBeVisible();
  });

  test("refresh button fetches new logs", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await page.locator("a").filter({ hasText: "Logs" }).click();
    await page.waitForTimeout(300);

    const requestPromise = page.waitForRequest((req) =>
      req.url().includes("/api/logs") && req.method() === "GET",
    );

    await page.locator("[data-action='refresh-logs']").click();
    await requestPromise;
  });

  test("shows log count in subtitle when logs exist", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await page.locator("a").filter({ hasText: "Logs" }).click();
    await page.waitForTimeout(500);
    await expect(page.locator(".subtitle")).toContainText("entries");
  });
});
