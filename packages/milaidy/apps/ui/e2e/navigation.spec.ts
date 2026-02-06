import { test, expect } from "@playwright/test";
import { mockApi } from "./helpers.js";

test.describe("Navigation", () => {
  test("defaults to chat tab", async ({ page }) => {
    await mockApi(page, { onboardingComplete: true, agentState: "running" });
    await page.goto("/");

    // Should show chat content
    await expect(page.getByPlaceholder("Type a message...")).toBeVisible();
  });

  test("navigates to plugins tab", async ({ page }) => {
    await mockApi(page, { onboardingComplete: true, agentState: "running" });
    await page.goto("/");

    await page.getByRole("link", { name: "Plugins" }).click();

    await expect(page).toHaveURL(/\/plugins/);
    await expect(page.getByText("Manage plugins and integrations")).toBeVisible();
  });

  test("navigates to skills tab", async ({ page }) => {
    await mockApi(page, { onboardingComplete: true, agentState: "running" });
    await page.goto("/");

    await page.getByRole("link", { name: "Skills" }).click();

    await expect(page).toHaveURL(/\/skills/);
    await expect(page.getByText("View available agent skills")).toBeVisible();
  });

  test("navigates to config tab", async ({ page }) => {
    await mockApi(page, { onboardingComplete: true, agentState: "running" });
    await page.goto("/");

    await page.getByRole("link", { name: "Config" }).click();

    await expect(page).toHaveURL(/\/config/);
    await expect(page.getByText("Edit ~/.milaidy/milaidy.json")).toBeVisible();
  });

  test("navigates to logs tab", async ({ page }) => {
    await mockApi(page, { onboardingComplete: true, agentState: "running" });
    await page.goto("/");

    await page.getByRole("link", { name: "Logs" }).click();

    await expect(page).toHaveURL(/\/logs/);
    await expect(page.getByText("Agent log output")).toBeVisible();
  });

  test("highlights active tab", async ({ page }) => {
    await mockApi(page, { onboardingComplete: true, agentState: "running" });
    await page.goto("/plugins");

    const pluginsLink = page.getByRole("link", { name: "Plugins" });
    await expect(pluginsLink).toHaveClass(/active/);
  });

  test("handles direct URL navigation", async ({ page }) => {
    await mockApi(page, { onboardingComplete: true, agentState: "running" });
    await page.goto("/config");

    await expect(page.getByText("Edit ~/.milaidy/milaidy.json")).toBeVisible();
  });

  test("handles browser back button", async ({ page }) => {
    await mockApi(page, { onboardingComplete: true, agentState: "running" });
    await page.goto("/chat");

    await page.getByRole("link", { name: "Plugins" }).click();
    await expect(page).toHaveURL(/\/plugins/);

    await page.goBack();
    await expect(page).toHaveURL(/\/chat/);
  });
});
