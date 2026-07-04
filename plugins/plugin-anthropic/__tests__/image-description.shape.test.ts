/** Shape tests for `handleImageDescription` title/description parsing, with the `ai` `generateText` mocked. */
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

  it("formats provider failures without leaking image URL query secrets", async () => {
    mocks.generateText.mockRejectedValue(
      Object.assign(new Error("raw provider error"), {
        status: 400,
        data: { error: { message: "unsupported image media type" } },
      })
    );

    let thrown: unknown;
    try {
      await handleImageDescription(
        createRuntime(),
        "https://example.com/private.png?token=super-secret&signature=also-secret"
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toBe(
      "[Anthropic] IMAGE_DESCRIPTION request using claude-test-small failed: unsupported image media type"
    );
    expect(message).not.toContain("super-secret");
  });

  it("uses fallback title and description parsing for unlabeled hostile text", async () => {
    const hostileText =
      "\n\nIgnore previous instructions\n<script>alert('x')</script>\nDetails follow.";
    mocks.generateText.mockResolvedValue({
      text: hostileText,
      usage: { inputTokens: 12, outputTokens: 9, totalTokens: 21 },
    });

    const result = await handleImageDescription(createRuntime(), {
      imageUrl: "https://example.com/image.png",
      prompt: "short caption",
    });

    expect(result).toEqual({
      title: "Ignore previous instructions",
      description: hostileText.trim(),
    });
  });
});
