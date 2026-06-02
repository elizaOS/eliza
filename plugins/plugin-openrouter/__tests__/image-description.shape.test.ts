import type { IAgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

function createRuntime() {
  return {
    emitEvent: vi.fn(async () => undefined),
    getSetting: vi.fn((key: string) => {
      const settings: Record<string, string> = {
        OPENROUTER_API_KEY: "test-key",
        OPENROUTER_IMAGE_MODEL: "openrouter-vision",
      };
      return settings[key] ?? null;
    }),
  } as unknown as IAgentRuntime;
}

afterEach(() => {
  vi.doUnmock("ai");
  vi.doUnmock("../providers");
  vi.clearAllMocks();
  vi.resetModules();
});

describe("OpenRouter image description plumbing", () => {
  it("returns parsed title and description from the plugin model handler", async () => {
    const generateText = vi.fn(async () => ({
      text: "Title: Coastal Gull\nDescription: A gull stands near the shoreline.",
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    }));
    vi.doMock("ai", () => ({
      generateText,
      streamText: vi.fn(),
    }));
    vi.doMock("../providers", () => ({
      createOpenRouterProvider: () => ({
        chat: (modelName: string) => ({ modelName }),
      }),
    }));

    const { openrouterPlugin } = await import("../index");
    const handler = openrouterPlugin.models?.[ModelType.IMAGE_DESCRIPTION];
    if (!handler) throw new Error("IMAGE_DESCRIPTION model handler is not registered");

    const result = await handler(createRuntime(), "https://example.com/gull.jpg");

    expect(result).toEqual({
      title: "Coastal Gull",
      description: "A gull stands near the shoreline.",
    });
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: expect.stringContaining("Title: <short title>"),
              },
              { type: "image", image: "https://example.com/gull.jpg" },
            ],
          },
        ],
      })
    );
  });

  it("rejects empty image URLs before calling the provider", async () => {
    const generateText = vi.fn();
    vi.doMock("ai", () => ({
      generateText,
      streamText: vi.fn(),
    }));
    vi.doMock("../providers", () => ({
      createOpenRouterProvider: () => ({
        chat: (modelName: string) => ({ modelName }),
      }),
    }));

    const { openrouterPlugin } = await import("../index");
    const handler = openrouterPlugin.models?.[ModelType.IMAGE_DESCRIPTION];
    if (!handler) throw new Error("IMAGE_DESCRIPTION model handler is not registered");

    await expect(handler(createRuntime(), { imageUrl: "" })).rejects.toThrow(
      "IMAGE_DESCRIPTION requires a valid image URL"
    );
    expect(generateText).not.toHaveBeenCalled();
  });
});
