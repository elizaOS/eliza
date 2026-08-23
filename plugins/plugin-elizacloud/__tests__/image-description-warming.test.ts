/**
 * Regression coverage for the image model handlers' transient cold-cache
 * warming handling. On this class of box, text runs on Cerebras so the cloud's
 * per-model billing/auth admission cache goes cold between rare image calls;
 * the first image then hits a warming 503/error that clears within ~1s on
 * retry (the client companion to the server escape in #18249).
 *   - handleImageDescription: retry the `billing_cache_warming` 503 in place,
 *     and throw (fail closed) instead of fabricating a `{ description:"Error" }`.
 *   - handleImageGeneration: retry the "admission cache is warming" throw.
 * The cloud SDK client is mocked; no network.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const postRaw = vi.fn();
const generateImage = vi.fn();
vi.mock("../src/utils/sdk-client", () => ({
  createElizaCloudClient: () => ({
    routes: { postApiV1ChatCompletionsRaw: postRaw },
    generateImage,
  }),
}));
vi.mock("../src/utils/config", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getImageGenerationModel: () => "google/nano-banana-2/text-to-image",
    getImageDescriptionModel: () => "openai/gpt-4o-mini",
  };
});

const { handleImageDescription, handleImageGeneration } = await import("../src/models/image");

function runtime(settings: Record<string, string> = {}): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key] ?? "",
    emitEvent: () => {},
  } as unknown as IAgentRuntime;
}

function warming503(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: "Billing authorization is warming. Retry shortly.",
        type: "service_unavailable",
        code: "billing_cache_warming",
        retryAfter: 1,
      },
    }),
    { status: 503, headers: { "Content-Type": "application/json" } }
  );
}

function ok(description: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: description } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("handleImageDescription warming-503 retry", () => {
  afterEach(() => postRaw.mockReset());

  it("rides through a cold-cache warming 503 and returns the description", async () => {
    postRaw.mockResolvedValueOnce(warming503()).mockResolvedValueOnce(ok("A red square."));
    const result = await handleImageDescription(runtime(), {
      imageUrl: "https://example.com/red.png",
      prompt: "describe",
    });
    expect(postRaw).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).toContain("red square");
  });

  it("omits the output cap unless an operator explicitly configures it", async () => {
    postRaw.mockResolvedValue(ok("Complete description."));
    await handleImageDescription(runtime(), "https://example.com/full.png");
    expect(postRaw.mock.calls[0]?.[0]?.json).not.toHaveProperty("max_tokens");

    postRaw.mockClear();
    postRaw.mockResolvedValue(ok("Complete description."));
    await handleImageDescription(
      runtime({ ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MAX_TOKENS: "16384" }),
      "https://example.com/full.png"
    );
    expect(postRaw.mock.calls[0]?.[0]?.json?.max_tokens).toBe(16384);
  });

  it("rejects an invalid explicit image output budget before dispatch", async () => {
    await expect(
      handleImageDescription(
        runtime({ ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MAX_TOKENS: "8192oops" }),
        "https://example.com/full.png"
      )
    ).rejects.toMatchObject({ code: "ELIZAOS_CLOUD_IMAGE_OUTPUT_BUDGET_INVALID" });
    expect(postRaw).not.toHaveBeenCalled();
  });

  it("throws (fails closed) on a hard 500 instead of fabricating a description", async () => {
    postRaw.mockResolvedValue(new Response("upstream boom", { status: 500 }));
    await expect(
      handleImageDescription(runtime(), {
        imageUrl: "https://example.com/x.png",
        prompt: "describe",
      })
    ).rejects.toThrow();
  });

  it("fails fast on a non-warming 503 (one attempt)", async () => {
    postRaw.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "gone" } }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      })
    );
    await expect(
      handleImageDescription(runtime(), {
        imageUrl: "https://example.com/x.png",
        prompt: "describe",
      })
    ).rejects.toThrow();
    expect(postRaw).toHaveBeenCalledTimes(1);
  });
});

describe("handleImageGeneration warming retry", () => {
  afterEach(() => generateImage.mockReset());

  it("rides through a generative cold-cache warming throw and returns the image", async () => {
    generateImage
      .mockRejectedValueOnce(new Error("Generative admission cache is warming; retry shortly"))
      .mockResolvedValueOnce({ images: [{ url: "https://cdn/x.png" }] });
    const result = await handleImageGeneration(runtime(), {
      prompt: "a red circle",
    });
    expect(generateImage).toHaveBeenCalledTimes(2);
    expect(result).toEqual([{ url: "https://cdn/x.png" }]);
  });

  it("fails fast on a non-warming generation error", async () => {
    generateImage.mockRejectedValue(new Error("Unsupported image model"));
    await expect(handleImageGeneration(runtime(), { prompt: "a red circle" })).rejects.toThrow(
      "Unsupported image model"
    );
    expect(generateImage).toHaveBeenCalledTimes(1);
  });
});
