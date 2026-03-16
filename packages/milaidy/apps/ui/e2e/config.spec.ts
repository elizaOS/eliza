import { test, expect } from "@playwright/test";
import { mockApi } from "./helpers";

test.describe("Config page", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await page.locator("a").filter({ hasText: "Config" }).click();
    await page.waitForTimeout(300);
  });

  test("displays config heading", async ({ page }) => {
    await expect(page.locator("h2")).toHaveText("Config");
  });

  test("shows subtitle with config path", async ({ page }) => {
    await expect(page.locator(".subtitle")).toContainText("milaidy.json");
  });

  test("displays config JSON in textarea", async ({ page }) => {
    const editor = page.locator(".config-editor");
    await expect(editor).toBeVisible();
    // Wait for config to load
    await page.waitForTimeout(500);
    const value = await editor.inputValue();
    expect(value).toContain("name");
  });

  test("textarea is editable", async ({ page }) => {
    const editor = page.locator(".config-editor");
    await editor.fill('{"test": true}');
    const value = await editor.inputValue();
    expect(value).toBe('{"test": true}');
  });

  test("Save button is visible", async ({ page }) => {
    await expect(page.locator("button").filter({ hasText: "Save" })).toBeVisible();
  });

  test("clicking Save sends PUT /api/config", async ({ page }) => {
    const editor = page.locator(".config-editor");
    await editor.fill('{"agent": {"name": "Updated"}}');

    const requestPromise = page.waitForRequest((req) =>
      req.url().includes("/api/config") && req.method() === "PUT",
    );

    await page.locator("button").filter({ hasText: "Save" }).click();
    const request = await requestPromise;
    const body = request.postDataJSON() as Record<string, unknown>;
    expect((body.agent as Record<string, string>).name).toBe("Updated");
  });
});
