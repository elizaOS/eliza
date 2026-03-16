import { test, expect } from "@playwright/test";
import { mockApi, simulateAgentResponse } from "./helpers";

test.describe("Chat page", () => {
  test("shows chat interface when agent is running", async ({ page }) => {
    await mockApi(page, { agentState: "running" });
    await page.goto("/chat");
    await expect(page.locator(".chat-input")).toBeVisible();
  });

  test("shows Start button when agent is not running", async ({ page }) => {
    await mockApi(page, { agentState: "not_started" });
    await page.goto("/chat");
    await expect(page.locator("button").filter({ hasText: "Start Agent" })).toBeVisible();
  });

  test("shows empty state when no messages", async ({ page }) => {
    await mockApi(page, { agentState: "running" });
    await page.goto("/chat");
    await expect(page.getByText("Send a message to start chatting")).toBeVisible();
  });

  test("can type a message in the input", async ({ page }) => {
    await mockApi(page, { agentState: "running" });
    await page.goto("/chat");
    const input = page.locator(".chat-input");
    await input.fill("Hello agent");
    await expect(input).toHaveValue("Hello agent");
  });

  test("send button is visible", async ({ page }) => {
    await mockApi(page, { agentState: "running" });
    await page.goto("/chat");
    await expect(page.locator("button").filter({ hasText: "Send" })).toBeVisible();
  });

  test("sending a message shows it in the chat", async ({ page }) => {
    await mockApi(page, { agentState: "running" });
    await page.goto("/chat");

    const input = page.locator(".chat-input");
    await input.fill("Hello!");
    await page.locator("button").filter({ hasText: "Send" }).click();

    await expect(page.getByText("Hello!")).toBeVisible();
  });

  test("agent name shows in header", async ({ page }) => {
    await mockApi(page, { agentName: "TestBot" });
    await page.goto("/chat");
    await expect(page.locator(".logo")).toHaveText("TestBot");
  });

  test("status pill shows running state", async ({ page }) => {
    await mockApi(page, { agentState: "running" });
    await page.goto("/chat");
    await expect(page.locator(".status-pill")).toHaveText("running");
  });

  // --- Enhanced: Send + Receive ---

  test("input clears after sending a message", async ({ page }) => {
    await mockApi(page, { agentState: "running" });
    await page.goto("/chat");

    const input = page.locator(".chat-input");
    await input.fill("Hi there");
    await page.locator("button").filter({ hasText: "Send" }).click();

    await expect(input).toHaveValue("");
  });

  test("shows sending indicator while waiting for response", async ({ page }) => {
    await mockApi(page, { agentState: "running" });
    await page.goto("/chat");

    const input = page.locator(".chat-input");
    await input.fill("Thinking test");
    await page.locator("button").filter({ hasText: "Send" }).click();

    // Button text should change to "..." while sending
    await expect(page.locator("button").filter({ hasText: "..." })).toBeVisible();
  });

  test("input is disabled while sending", async ({ page }) => {
    await mockApi(page, { agentState: "running" });
    await page.goto("/chat");

    const input = page.locator(".chat-input");
    await input.fill("Disable test");
    await page.locator("button").filter({ hasText: "Send" }).click();

    await expect(input).toBeDisabled();
  });

  test("user message shows 'You' as the role label", async ({ page }) => {
    await mockApi(page, { agentState: "running" });
    await page.goto("/chat");

    const input = page.locator(".chat-input");
    await input.fill("Role test");
    await page.locator("button").filter({ hasText: "Send" }).click();

    await expect(page.locator(".chat-msg.user .role")).toHaveText("You");
  });

  test("agent response appears in the chat", async ({ page }) => {
    await mockApi(page, { agentState: "running" });
    await page.goto("/chat");

    // Send a user message
    const input = page.locator(".chat-input");
    await input.fill("Hello agent!");
    await page.locator("button").filter({ hasText: "Send" }).click();
    await expect(page.getByText("Hello agent!")).toBeVisible();

    // Simulate agent responding
    await simulateAgentResponse(page, "Hello! I'm here to help.");
    await expect(page.getByText("Hello! I'm here to help.")).toBeVisible();
  });

  test("agent response shows agent name as role label", async ({ page }) => {
    await mockApi(page, { agentState: "running", agentName: "Reimu" });
    await page.goto("/chat");

    const input = page.locator(".chat-input");
    await input.fill("Name test");
    await page.locator("button").filter({ hasText: "Send" }).click();

    await simulateAgentResponse(page, "I am Reimu!");
    await expect(page.locator(".chat-msg.assistant .role")).toHaveText("Reimu");
  });

  test("send button restores after agent responds", async ({ page }) => {
    await mockApi(page, { agentState: "running" });
    await page.goto("/chat");

    const input = page.locator(".chat-input");
    await input.fill("Restore test");
    await page.locator("button").filter({ hasText: "Send" }).click();

    // Should be in sending state
    await expect(page.locator("button").filter({ hasText: "..." })).toBeVisible();

    // After response, Send button comes back
    await simulateAgentResponse(page, "Done!");
    await expect(page.locator("button").filter({ hasText: "Send" })).toBeVisible();
  });

  test("input re-enables after agent responds", async ({ page }) => {
    await mockApi(page, { agentState: "running" });
    await page.goto("/chat");

    const input = page.locator(".chat-input");
    await input.fill("Enable test");
    await page.locator("button").filter({ hasText: "Send" }).click();
    await expect(input).toBeDisabled();

    await simulateAgentResponse(page, "Enabled now!");
    await expect(input).toBeEnabled();
  });

  test("multi-turn conversation shows all messages in order", async ({ page }) => {
    await mockApi(page, { agentState: "running", agentName: "Agent" });
    await page.goto("/chat");

    const input = page.locator(".chat-input");

    // Turn 1
    await input.fill("First question");
    await page.locator("button").filter({ hasText: "Send" }).click();
    await simulateAgentResponse(page, "First answer");

    // Turn 2
    await input.fill("Second question");
    await page.locator("button").filter({ hasText: "Send" }).click();
    await simulateAgentResponse(page, "Second answer");

    // Verify all messages are visible in order
    const messages = page.locator(".chat-msg");
    await expect(messages).toHaveCount(4);
    await expect(messages.nth(0)).toContainText("First question");
    await expect(messages.nth(1)).toContainText("First answer");
    await expect(messages.nth(2)).toContainText("Second question");
    await expect(messages.nth(3)).toContainText("Second answer");
  });

  test("pressing Enter sends a message", async ({ page }) => {
    await mockApi(page, { agentState: "running" });
    await page.goto("/chat");

    const input = page.locator(".chat-input");
    await input.fill("Enter key test");
    await input.press("Enter");

    await expect(page.getByText("Enter key test")).toBeVisible();
  });

  test("empty input does not send a message", async ({ page }) => {
    await mockApi(page, { agentState: "running" });
    await page.goto("/chat");

    // Click Send with empty input
    await page.locator("button").filter({ hasText: "Send" }).click();

    // Empty state should still be visible (no message sent)
    await expect(page.getByText("Send a message to start chatting")).toBeVisible();
  });

  test("empty state disappears after first message", async ({ page }) => {
    await mockApi(page, { agentState: "running" });
    await page.goto("/chat");

    await expect(page.getByText("Send a message to start chatting")).toBeVisible();

    const input = page.locator(".chat-input");
    await input.fill("Goodbye empty state");
    await page.locator("button").filter({ hasText: "Send" }).click();

    await expect(page.getByText("Send a message to start chatting")).not.toBeVisible();
  });

  test("clicking Start Agent on stopped state sends start request and shows chat", async ({ page }) => {
    await mockApi(page, { agentState: "not_started" });
    await page.goto("/chat");

    // Click Start Agent
    await page.locator("button").filter({ hasText: "Start Agent" }).click();

    // After start, agent is running - chat input should appear
    await expect(page.locator(".chat-input")).toBeVisible();
  });
});
