/**
 * Unit tests for conversation utils: validates title fallbacks, avatar hashing, and provider mappings.
 */
import { describe, expect, it } from "vitest";
import {
  avatarIndexFromConversationId,
  getLocalizedConversationTitle,
  isNonChatModelLabel,
  resolveProviderLabel,
} from "./conversation-utils.ts";

describe("conversation-utils", () => {
  it("returns localized title for empty or default conversation names", () => {
    const t = (_k: string) => "New Chat";
    expect(getLocalizedConversationTitle("", t)).toBe("New Chat");
    expect(getLocalizedConversationTitle("New Chat", t)).toBe("New Chat");
    expect(getLocalizedConversationTitle("Custom Title", t)).toBe(
      "Custom Title",
    );
  });

  it("computes positive avatar index from conversation ID string", () => {
    const idx = avatarIndexFromConversationId("conv-12345");
    expect(idx).toBeGreaterThanOrEqual(1);
  });

  it("resolves provider label from model identifier", () => {
    expect(resolveProviderLabel("openai/gpt-4o")).toBe("OpenAI");
    expect(resolveProviderLabel("anthropic/claude-3-5-sonnet")).toBe(
      "Anthropic",
    );
    expect(resolveProviderLabel("gemini-2.0-flash")).toBe("Google");
    expect(resolveProviderLabel("")).toBe("");
  });

  it("identifies non-chat utility/embedding models", () => {
    expect(isNonChatModelLabel("text_embedding")).toBe(true);
    expect(isNonChatModelLabel("openai/text-embedding-3-small")).toBe(true);
    expect(isNonChatModelLabel("gpt-4o")).toBe(false);
  });
});
