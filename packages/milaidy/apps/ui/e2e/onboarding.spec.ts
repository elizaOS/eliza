import { test, expect } from "@playwright/test";
import { mockApi } from "./helpers.js";

test.describe("Onboarding Wizard", () => {
  test("shows welcome screen when onboarding is incomplete", async ({ page }) => {
    await mockApi(page, { onboardingComplete: false });
    await page.goto("/");
    await expect(page.getByText("Welcome to Milaidy")).toBeVisible();
    await expect(page.getByText("Get Started")).toBeVisible();
  });

  test("navigates through name selection step", async ({ page }) => {
    await mockApi(page, { onboardingComplete: false });
    await page.goto("/");

    // Step 1: Welcome
    await page.getByText("Get Started").click();

    // Step 2: Name
    await expect(page.getByText("Name your agent")).toBeVisible();
    await expect(page.getByText("Reimu")).toBeVisible();
    await expect(page.getByText("Flandre")).toBeVisible();

    // Select a preset name
    await page.getByText("Sakuya").click();
    await page.getByText("Next").click();

    // Step 3: Style
    await expect(page.getByText("Choose a vibe")).toBeVisible();
  });

  test("allows custom name input", async ({ page }) => {
    await mockApi(page, { onboardingComplete: false });
    await page.goto("/");

    await page.getByText("Get Started").click();

    // Type custom name
    await page.getByPlaceholder("Or type a custom name").fill("TestAgent");
    await page.getByText("Next").click();

    await expect(page.getByText("Choose a vibe")).toBeVisible();
    await expect(page.getByText("TestAgent")).toBeVisible();
  });

  test("navigates through style selection step", async ({ page }) => {
    await mockApi(page, { onboardingComplete: false });
    await page.goto("/");

    // Get to style step
    await page.getByText("Get Started").click();
    await page.getByText("Reimu").click();
    await page.getByText("Next").click();

    // Step 3: Style
    await expect(page.getByText("uwu~")).toBeVisible();
    await expect(page.getByText("hell yeah")).toBeVisible();
    await expect(page.getByText("Noted.")).toBeVisible();

    await page.getByText("uwu~").click();
    await page.getByText("Next").click();

    // Step 4: Provider
    await expect(page.getByText("Choose your AI provider")).toBeVisible();
  });

  test("shows provider options with Eliza Cloud first", async ({ page }) => {
    await mockApi(page, { onboardingComplete: false });
    await page.goto("/");

    // Get to provider step
    await page.getByText("Get Started").click();
    await page.getByText("Reimu").click();
    await page.getByText("Next").click();
    await page.getByText("uwu~").click();
    await page.getByText("Next").click();

    // Step 4: Provider
    const providers = page.locator(".onboarding-option");
    const firstProvider = providers.first();
    await expect(firstProvider.getByText("Eliza Cloud")).toBeVisible();
    await expect(page.getByText("Anthropic")).toBeVisible();
    await expect(page.getByText("OpenAI")).toBeVisible();
  });

  test("shows API key input for non-cloud providers", async ({ page }) => {
    await mockApi(page, { onboardingComplete: false });
    await page.goto("/");

    // Get to provider step
    await page.getByText("Get Started").click();
    await page.getByText("Reimu").click();
    await page.getByText("Next").click();
    await page.getByText("uwu~").click();
    await page.getByText("Next").click();

    // Select Anthropic (requires key)
    await page.getByText("Anthropic").click();
    await expect(page.getByPlaceholder("API Key")).toBeVisible();

    // Select Eliza Cloud (no key needed)
    await page.getByText("Eliza Cloud").click();
    await expect(page.getByPlaceholder("API Key")).not.toBeVisible();
  });

  test("shows channel setup step and allows skip", async ({ page }) => {
    await mockApi(page, { onboardingComplete: false });
    await page.goto("/");

    // Get to channels step
    await page.getByText("Get Started").click();
    await page.getByText("Reimu").click();
    await page.getByText("Next").click();
    await page.getByText("uwu~").click();
    await page.getByText("Next").click();
    await page.getByText("Eliza Cloud").click();
    await page.getByText("Next").click();

    // Step 5: Channels
    await expect(page.getByText("Connect to messaging")).toBeVisible();
    await expect(page.getByText("Telegram Bot Token")).toBeVisible();
    await expect(page.getByText("Discord Bot Token")).toBeVisible();
    await expect(page.getByRole("button", { name: "Skip" })).toBeVisible();
    await expect(page.getByText("Finish")).toBeVisible();
  });

  test("completes onboarding and shows chat view", async ({ page }) => {
    await mockApi(page, { onboardingComplete: false, agentState: "running", agentName: "Reimu" });
    await page.goto("/");

    // Complete all steps
    await page.getByText("Get Started").click();
    await page.getByText("Reimu").click();
    await page.getByText("Next").click();
    await page.getByText("uwu~").click();
    await page.getByText("Next").click();
    await page.getByText("Eliza Cloud").click();
    await page.getByText("Next").click();

    // After onboarding POST, the mock returns complete: true on reload
    // but since we mock agent/start too, the UI should transition
    await page.getByRole("button", { name: "Skip" }).click();

    // Should now show the main app (agent started)
    await expect(page.getByText("Reimu")).toBeVisible();
  });
});
