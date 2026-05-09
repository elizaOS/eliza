import { describe, test, expect } from "bun:test";
import { buildConversationContext } from "../../src/utils/context";
import { createMockMessage, createMockState } from "../helpers/mockRuntime";

describe("buildConversationContext", () => {
  test("returns message text when no recent messages in values", () => {
    const message = createMockMessage({
      content: { text: "Activate my workflow" },
    });
    const state = createMockState();

    const result = buildConversationContext(message, state);
    expect(result).toBe("Activate my workflow");
  });

  test("returns empty string when no text and no recent messages", () => {
    const message = createMockMessage({ content: { text: "" } });
    const state = createMockState();

    const result = buildConversationContext(message, state);
    expect(result).toBe("");
  });

  test("handles undefined state", () => {
    const message = createMockMessage({ content: { text: "Hello" } });

    const result = buildConversationContext(message, undefined);
    expect(result).toBe("Hello");
  });

  test("appends current request to recentMessages", () => {
    const message = createMockMessage({ content: { text: "Activate it" } });
    const state = createMockState({
      values: {
        recentMessages:
          "User: Show me my workflows\nAssistant: Here are your workflows: Stripe, Gmail",
      },
    });

    const result = buildConversationContext(message, state);
    expect(result).toContain("User: Show me my workflows");
    expect(result).toContain("Assistant: Here are your workflows");
    expect(result).toContain("Current request: Activate it");
  });

  test("preserves recentMessages formatting from provider", () => {
    const message = createMockMessage({ content: { text: "Do something" } });
    const preformattedMessages = `[2024-01-01 10:00] Alice: Hello
[2024-01-01 10:01] Bot: Hi there!
[2024-01-01 10:02] Alice: Help me`;

    const state = createMockState({
      values: { recentMessages: preformattedMessages },
    });

    const result = buildConversationContext(message, state);
    expect(result).toBe(
      `${preformattedMessages}\n\nCurrent request: Do something`,
    );
  });
});
