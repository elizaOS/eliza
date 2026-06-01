import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleImageDescription } from "../models/image";

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
}));

vi.mock("ai", () => ({
  generateText: mocks.generateText,
}));

vi.mock("../providers/anthropic", () => ({
  createAnthropicClientWithTopPSupport: () => (modelName: string) => ({ modelName }),
}));

function createRuntime() {
  return {
    emitEvent: vi.fn(async () => undefined),
    getSetting: vi.fn((key: string) => {
      const settings: Record<string, string> = {
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_SMALL_MODEL: "claude-test-small",
      };
      return settings[key] ?? null;
    }),
  } as unknown as IAgentRuntime;
}

afterEach(() => {
  mocks.generateText.mockReset();
});

describe("Anthropic image description plumbing", () => {
  it("returns parsed title and description from model output", async () => {
    mocks.generateText.mockResolvedValue({
      text: "Title: Desk Screenshot\nDescription: A dashboard with metrics and filters.",
      usage: { inputTokens: 12, outputTokens: 9, totalTokens: 21 },
    });

    const result = await handleImageDescription(createRuntime(), "https://example.com/screen.png");

    expect(result).toEqual({
      title: "Desk Screenshot",
      description: "A dashboard with metrics and filters.",
    });
    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputTokens: 1024,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: expect.stringContaining("Title: <short title>"),
              },
              { type: "image", image: "https://example.com/screen.png" },
            ],
          },
        ],
      })
    );
  });

  it("rejects empty image URLs before calling the provider", async () => {
    await expect(handleImageDescription(createRuntime(), { imageUrl: "" })).rejects.toThrow(
      "IMAGE_DESCRIPTION requires a valid image URL"
    );
    expect(mocks.generateText).not.toHaveBeenCalled();
  });
});
