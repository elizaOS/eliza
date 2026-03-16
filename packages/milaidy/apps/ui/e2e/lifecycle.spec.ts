import { test, expect } from "@playwright/test";
import { mockApi } from "./helpers";

test.describe("Agent lifecycle", () => {
  // --- Button visibility per state ---

  test("shows Start button when agent is not started", async ({ page }) => {
    await mockApi(page, { agentState: "not_started" });
    await page.goto("/chat");
    await expect(page.locator(".lifecycle-btn").filter({ hasText: "Start" })).toBeVisible();
  });

  test("shows Pause and Stop buttons when agent is running", async ({ page }) => {
    await mockApi(page, { agentState: "running" });
    await page.goto("/chat");
    await expect(page.locator(".lifecycle-btn").filter({ hasText: "Pause" })).toBeVisible();
    await expect(page.locator(".lifecycle-btn").filter({ hasText: "Stop" })).toBeVisible();
  });

  test("shows Resume and Stop buttons when agent is paused", async ({ page }) => {
    await mockApi(page, { agentState: "paused" });
    await page.goto("/chat");
    await expect(page.locator(".lifecycle-btn").filter({ hasText: "Resume" })).toBeVisible();
    await expect(page.locator(".lifecycle-btn").filter({ hasText: "Stop" })).toBeVisible();
  });

  test("shows Start button when agent is stopped", async ({ page }) => {
    await mockApi(page, { agentState: "stopped" });
    await page.goto("/chat");
    await expect(page.locator(".lifecycle-btn").filter({ hasText: "Start" })).toBeVisible();
  });

  // --- Status pill ---

  test("status pill shows correct state text", async ({ page }) => {
    await mockApi(page, { agentState: "running" });
    await page.goto("/chat");
    await expect(page.locator(".status-pill")).toHaveText("running");
  });

  test("status pill shows paused state", async ({ page }) => {
    await mockApi(page, { agentState: "paused" });
    await page.goto("/chat");
    await expect(page.locator(".status-pill")).toHaveText("paused");
  });

  // --- API calls ---

  test("clicking Start sends POST /api/agent/start", async ({ page }) => {
    await mockApi(page, { agentState: "not_started" });
    await page.goto("/chat");

    const requestPromise = page.waitForRequest((req) =>
      req.url().includes("/api/agent/start") && req.method() === "POST",
    );

    await page.locator(".lifecycle-btn").filter({ hasText: "Start" }).click();
    await requestPromise;
  });

  test("clicking Pause sends POST /api/agent/pause", async ({ page }) => {
    await mockApi(page, { agentState: "running" });
    await page.goto("/chat");

    const requestPromise = page.waitForRequest((req) =>
      req.url().includes("/api/agent/pause") && req.method() === "POST",
    );

    await page.locator(".lifecycle-btn").filter({ hasText: "Pause" }).click();
    await requestPromise;
  });

  test("clicking Stop sends POST /api/agent/stop", async ({ page }) => {
    await mockApi(page, { agentState: "running" });
    await page.goto("/chat");

    const requestPromise = page.waitForRequest((req) =>
      req.url().includes("/api/agent/stop") && req.method() === "POST",
    );

    await page.locator(".lifecycle-btn").filter({ hasText: "Stop" }).click();
    await requestPromise;
  });

  test("clicking Resume sends POST /api/agent/resume", async ({ page }) => {
    await mockApi(page, { agentState: "paused" });
    await page.goto("/chat");

    const requestPromise = page.waitForRequest((req) =>
      req.url().includes("/api/agent/resume") && req.method() === "POST",
    );

    await page.locator(".lifecycle-btn").filter({ hasText: "Resume" }).click();
    await requestPromise;
  });

  // --- UI updates after lifecycle actions ---

  test("starting agent updates status pill to running", async ({ page }) => {
    await mockApi(page, { agentState: "not_started" });
    await page.goto("/chat");

    await expect(page.locator(".status-pill")).toHaveText("not_started");
    await page.locator(".lifecycle-btn").filter({ hasText: "Start" }).click();
    await expect(page.locator(".status-pill")).toHaveText("running");
  });

  test("starting agent shows Pause and Stop buttons", async ({ page }) => {
    await mockApi(page, { agentState: "not_started" });
    await page.goto("/chat");

    await page.locator(".lifecycle-btn").filter({ hasText: "Start" }).click();
    await expect(page.locator(".lifecycle-btn").filter({ hasText: "Pause" })).toBeVisible();
    await expect(page.locator(".lifecycle-btn").filter({ hasText: "Stop" })).toBeVisible();
  });

  test("starting agent shows chat interface instead of start prompt", async ({ page }) => {
    await mockApi(page, { agentState: "not_started" });
    await page.goto("/chat");

    await expect(page.locator(".start-agent-box")).toBeVisible();
    await page.locator(".lifecycle-btn").filter({ hasText: "Start" }).click();
    await expect(page.locator(".chat-input")).toBeVisible();
  });

  test("pausing agent updates status pill to paused", async ({ page }) => {
    await mockApi(page, { agentState: "running" });
    await page.goto("/chat");

    await expect(page.locator(".status-pill")).toHaveText("running");
    await page.locator(".lifecycle-btn").filter({ hasText: "Pause" }).click();
    await expect(page.locator(".status-pill")).toHaveText("paused");
  });

  test("pausing agent changes Pause button to Resume", async ({ page }) => {
    await mockApi(page, { agentState: "running" });
    await page.goto("/chat");

    await page.locator(".lifecycle-btn").filter({ hasText: "Pause" }).click();
    await expect(page.locator(".lifecycle-btn").filter({ hasText: "Resume" })).toBeVisible();
  });

  test("resuming agent updates status pill back to running", async ({ page }) => {
    await mockApi(page, { agentState: "paused" });
    await page.goto("/chat");

    await expect(page.locator(".status-pill")).toHaveText("paused");
    await page.locator(".lifecycle-btn").filter({ hasText: "Resume" }).click();
    await expect(page.locator(".status-pill")).toHaveText("running");
  });

  test("stopping agent updates status pill to stopped", async ({ page }) => {
    await mockApi(page, { agentState: "running" });
    await page.goto("/chat");

    await expect(page.locator(".status-pill")).toHaveText("running");
    await page.locator(".lifecycle-btn").filter({ hasText: "Stop" }).click();
    await expect(page.locator(".status-pill")).toHaveText("stopped");
  });

  test("stopping agent shows Start button again", async ({ page }) => {
    await mockApi(page, { agentState: "running" });
    await page.goto("/chat");

    await page.locator(".lifecycle-btn").filter({ hasText: "Stop" }).click();
    await expect(page.locator(".lifecycle-btn").filter({ hasText: "Start" })).toBeVisible();
  });

  // --- Full lifecycle cycle ---

  test("full lifecycle: start -> pause -> resume -> stop", async ({ page }) => {
    await mockApi(page, { agentState: "not_started" });
    await page.goto("/chat");

    // Start
    await page.locator(".lifecycle-btn").filter({ hasText: "Start" }).click();
    await expect(page.locator(".status-pill")).toHaveText("running");

    // Pause
    await page.locator(".lifecycle-btn").filter({ hasText: "Pause" }).click();
    await expect(page.locator(".status-pill")).toHaveText("paused");

    // Resume
    await page.locator(".lifecycle-btn").filter({ hasText: "Resume" }).click();
    await expect(page.locator(".status-pill")).toHaveText("running");

    // Stop
    await page.locator(".lifecycle-btn").filter({ hasText: "Stop" }).click();
    await expect(page.locator(".status-pill")).toHaveText("stopped");

    // Restart
    await page.locator(".lifecycle-btn").filter({ hasText: "Start" }).click();
    await expect(page.locator(".status-pill")).toHaveText("running");
  });

  test("header shows agent name", async ({ page }) => {
    await mockApi(page, { agentName: "TestAgent" });
    await page.goto("/chat");
    await expect(page.locator(".logo")).toHaveText("TestAgent");
  });
});
