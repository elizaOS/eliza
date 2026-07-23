/**
 * Shape test for the image handlers with the `ai` SDK and provider mocked (no
 * live API): checks IMAGE_DESCRIPTION parses title/description from the model
 * text, verifies the active default image model reaches the provider, and checks
 * that blank image URLs and prompts are rejected before the provider is called.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

function createRuntime(
  settings: Record<string, string> = {
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_IMAGE_MODEL: "openrouter-vision",
  }
) {
  return {
    emitEvent: vi.fn(async () => undefined),
    getSetting: vi.fn((key: string) => settings[key] ?? null),
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

  it("routes image descriptions through the active default model when no override is set", async () => {
    const generateText = vi.fn(async () => ({
      text: "Title: Coastal Gull\nDescription: A gull stands near the shoreline.",
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    }));
    const chat = vi.fn((modelName: string) => ({ modelName }));
    vi.doMock("ai", () => ({
      generateText,
      streamText: vi.fn(),
    }));
    vi.doMock("../providers", () => ({
      createOpenRouterProvider: () => ({ chat }),
    }));

    const previousOpenRouterModel = process.env.OPENROUTER_IMAGE_MODEL;
    const previousGenericModel = process.env.IMAGE_MODEL;
    delete process.env.OPENROUTER_IMAGE_MODEL;
    delete process.env.IMAGE_MODEL;

    try {
      const { openrouterPlugin } = await import("../index");
      const handler = openrouterPlugin.models?.[ModelType.IMAGE_DESCRIPTION];
      if (!handler) throw new Error("IMAGE_DESCRIPTION model handler is not registered");

      await handler(
        createRuntime({ OPENROUTER_API_KEY: "test-key" }),
        "https://example.com/gull.jpg"
      );

      expect(chat).toHaveBeenCalledWith("openai/gpt-4o-mini");
    } finally {
      if (previousOpenRouterModel === undefined) {
        delete process.env.OPENROUTER_IMAGE_MODEL;
      } else {
        process.env.OPENROUTER_IMAGE_MODEL = previousOpenRouterModel;
      }
      if (previousGenericModel === undefined) {
        delete process.env.IMAGE_MODEL;
      } else {
        process.env.IMAGE_MODEL = previousGenericModel;
      }
    }
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

describe("OpenRouter image generation plumbing", () => {
  it("rejects blank prompts before calling the provider", async () => {
    const generateText = vi.fn();
    const chat = vi.fn();
    vi.doMock("ai", () => ({
      generateText,
      streamText: vi.fn(),
    }));
    vi.doMock("../providers", () => ({
      createOpenRouterProvider: () => ({ chat }),
    }));

    const { openrouterPlugin } = await import("../index");
    const handler = openrouterPlugin.models?.[ModelType.IMAGE];
    if (!handler) throw new Error("IMAGE model handler is not registered");

    await expect(handler(createRuntime(), { prompt: " \n\t " })).rejects.toThrow(
      "IMAGE generation requires a non-empty prompt"
    );
    expect(chat).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });
});
