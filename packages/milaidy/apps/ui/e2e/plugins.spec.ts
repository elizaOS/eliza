import { test, expect, type Locator } from "@playwright/test";
import { mockApi } from "./helpers";

/** Click the visual toggle switch that wraps a hidden checkbox. */
async function clickToggle(toggle: Locator): Promise<void> {
  await toggle.evaluate((el) => (el as HTMLInputElement).click());
}

test.describe("Plugins page", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await page.locator("a").filter({ hasText: "Plugins" }).click();
    await expect(page.locator("h2")).toHaveText("Plugins");
  });

  // --- Display ---

  test("displays the plugins heading and subtitle", async ({ page }) => {
    await expect(page.locator(".subtitle")).toContainText("plugins discovered");
  });

  test("lists all plugins from mock data", async ({ page }) => {
    const items = page.locator(".plugin-item");
    await expect(items).toHaveCount(12);
  });

  test("shows plugin names and descriptions", async ({ page }) => {
    await expect(page.locator(".plugin-name").first()).toBeTruthy();
    await expect(page.locator(".plugin-desc").first()).toBeTruthy();
  });

  test("shows enabled/disabled toggle for each plugin", async ({ page }) => {
    const toggles = page.locator("[data-plugin-toggle]");
    await expect(toggles).toHaveCount(12);
  });

  test("enabled plugins have checked toggles", async ({ page }) => {
    const anthropicToggle = page.locator("[data-plugin-toggle='anthropic']");
    await expect(anthropicToggle).toBeChecked();
  });

  test("disabled plugins have unchecked toggles", async ({ page }) => {
    const groqToggle = page.locator("[data-plugin-toggle='groq']");
    await expect(groqToggle).not.toBeChecked();
  });

  test("shows category badges", async ({ page }) => {
    await expect(page.getByText("provider").first()).toBeVisible();
    await expect(page.getByText("channel").first()).toBeVisible();
    await expect(page.getByText("feature").first()).toBeVisible();
  });

  test("shows env key requirements for plugins that need them", async ({ page }) => {
    await expect(page.locator("code").filter({ hasText: "ANTHROPIC_API_KEY" })).toBeVisible();
  });

  // --- Toggle ON: disabled -> enabled ---

  test("toggling a disabled plugin ON sends PUT with enabled:true", async ({ page }) => {
    const groqToggle = page.locator("[data-plugin-toggle='groq']");
    await expect(groqToggle).not.toBeChecked();

    const requestPromise = page.waitForRequest((req) =>
      req.url().includes("/api/plugins/groq") && req.method() === "PUT",
    );

    await clickToggle(groqToggle);

    const request = await requestPromise;
    const body = request.postDataJSON() as { enabled: boolean };
    expect(body.enabled).toBe(true);
  });

  test("toggling a disabled plugin ON updates the checkbox state", async ({ page }) => {
    const groqToggle = page.locator("[data-plugin-toggle='groq']");
    await expect(groqToggle).not.toBeChecked();

    await clickToggle(groqToggle);
    await expect(groqToggle).toBeChecked();
  });

  // --- Toggle OFF: enabled -> disabled ---

  test("toggling an enabled plugin OFF sends PUT with enabled:false", async ({ page }) => {
    const anthropicToggle = page.locator("[data-plugin-toggle='anthropic']");
    await expect(anthropicToggle).toBeChecked();

    const requestPromise = page.waitForRequest((req) =>
      req.url().includes("/api/plugins/anthropic") && req.method() === "PUT",
    );

    await clickToggle(anthropicToggle);

    const request = await requestPromise;
    const body = request.postDataJSON() as { enabled: boolean };
    expect(body.enabled).toBe(false);
  });

  test("toggling an enabled plugin OFF updates the checkbox state", async ({ page }) => {
    const anthropicToggle = page.locator("[data-plugin-toggle='anthropic']");
    await expect(anthropicToggle).toBeChecked();

    await clickToggle(anthropicToggle);
    await expect(anthropicToggle).not.toBeChecked();
  });

  // --- Toggle round-trip: OFF -> ON -> OFF ---

  test("plugin toggle round-trip: disable then re-enable", async ({ page }) => {
    const browserToggle = page.locator("[data-plugin-toggle='browser']");
    await expect(browserToggle).toBeChecked();

    // Disable
    await clickToggle(browserToggle);
    await expect(browserToggle).not.toBeChecked();

    // Re-enable
    await clickToggle(browserToggle);
    await expect(browserToggle).toBeChecked();
  });

  // --- Multiple plugin toggles ---

  test("can toggle multiple plugins independently", async ({ page }) => {
    const groq = page.locator("[data-plugin-toggle='groq']");
    const telegram = page.locator("[data-plugin-toggle='telegram']");

    await expect(groq).not.toBeChecked();
    await expect(telegram).not.toBeChecked();

    // Enable both
    await clickToggle(groq);
    await clickToggle(telegram);

    await expect(groq).toBeChecked();
    await expect(telegram).toBeChecked();
  });

  // --- Category filtering ---

  test("shows category filter buttons", async ({ page }) => {
    const filterBtns = page.locator(".plugin-filters button");
    await expect(filterBtns).toHaveCount(5); // all, provider, channel, feature, core
  });

  test("'All' filter is active by default", async ({ page }) => {
    const allBtn = page.locator(".filter-btn.active");
    await expect(allBtn).toContainText("All");
  });

  test("filtering by 'provider' shows only provider plugins", async ({ page }) => {
    await page.locator("[data-category='provider']").click();
    const items = page.locator(".plugin-item");
    // Anthropic, OpenAI, Groq, Ollama
    await expect(items).toHaveCount(4);
  });

  test("filtering by 'channel' shows only channel plugins", async ({ page }) => {
    await page.locator("[data-category='channel']").click();
    const items = page.locator(".plugin-item");
    // Telegram, Discord, Slack
    await expect(items).toHaveCount(3);
  });

  test("filtering by 'core' shows only core plugins", async ({ page }) => {
    await page.locator("[data-category='core']").click();
    const items = page.locator(".plugin-item");
    // SQL
    await expect(items).toHaveCount(1);
  });

  test("filtering by 'feature' shows only feature plugins", async ({ page }) => {
    await page.locator("[data-category='feature']").click();
    const items = page.locator(".plugin-item");
    // Browser, Shell, Cron, Knowledge
    await expect(items).toHaveCount(4);
  });

  test("switching back to 'All' shows all plugins again", async ({ page }) => {
    await page.locator("[data-category='provider']").click();
    await expect(page.locator(".plugin-item")).toHaveCount(4);
    await page.locator("[data-category='all']").click();
    await expect(page.locator(".plugin-item")).toHaveCount(12);
  });

  test("active filter button changes when selecting a category", async ({ page }) => {
    await page.locator("[data-category='channel']").click();
    const activeBtn = page.locator(".filter-btn.active");
    await expect(activeBtn).toContainText("Channel");
  });

  // --- Toggle within filtered view ---

  test("can toggle a plugin within a filtered category view", async ({ page }) => {
    await page.locator("[data-category='provider']").click();
    await expect(page.locator(".plugin-item")).toHaveCount(4);

    const groqToggle = page.locator("[data-plugin-toggle='groq']");
    await expect(groqToggle).not.toBeChecked();

    const requestPromise = page.waitForRequest((req) =>
      req.url().includes("/api/plugins/groq") && req.method() === "PUT",
    );

    await clickToggle(groqToggle);
    await requestPromise;
    await expect(groqToggle).toBeChecked();
  });
});
