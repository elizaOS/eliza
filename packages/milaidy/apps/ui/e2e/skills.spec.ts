import { test, expect } from "@playwright/test";
import { mockApi } from "./helpers";

test.describe("Skills page", () => {
  test("displays skills heading", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await page.locator("a").filter({ hasText: "Skills" }).click();
    await expect(page.locator("h2")).toHaveText("Skills");
  });

  test("shows skills list when skills exist", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await page.locator("a").filter({ hasText: "Skills" }).click();
    await page.waitForTimeout(500);
    const items = page.locator("[data-skill-id]");
    await expect(items).toHaveCount(3);
  });

  test("shows skill names", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await page.locator("a").filter({ hasText: "Skills" }).click();
    await page.waitForTimeout(500);
    await expect(page.getByText("Web Search")).toBeVisible();
    await expect(page.getByText("Code Review")).toBeVisible();
  });

  test("shows active/inactive status badges", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await page.locator("a").filter({ hasText: "Skills" }).click();
    await page.waitForTimeout(500);
    const activeCount = await page.locator(".plugin-status.enabled").count();
    expect(activeCount).toBe(2);
  });

  test("shows empty state when no skills", async ({ page }) => {
    await mockApi(page, { skillCount: 0 });
    await page.goto("/");
    await page.locator("a").filter({ hasText: "Skills" }).click();
    await page.waitForTimeout(500);
    await expect(page.getByText("No skills loaded yet.")).toBeVisible();
  });

  test("shows skill count in subtitle", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await page.locator("a").filter({ hasText: "Skills" }).click();
    await page.waitForTimeout(500);
    await expect(page.locator(".subtitle")).toContainText("3 skills loaded");
  });
});
