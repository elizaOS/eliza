/**
 * Behavioral deadlines for OpenAI image generation and description.
 * Generation and vision-chat use separate named budgets (not one 30s fit-all).
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  handleImageDescriptionWithFetch,
  handleImageGenerationWithFetch,
} from "../models/image";

function createRuntime(): IAgentRuntime {
  return {
    character: { name: "Image timeout" },
    getSetting(key: string) {
      const values: Record<string, string> = {
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: "https://api.openai.invalid/v1",
        OPENAI_IMAGE_DESCRIPTION_BASE_URL: "https://api.openai.invalid/v1",
      };
      return values[key];
    },
  } as unknown as IAgentRuntime;
}

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected image abort signal");
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as typeof fetch;
}

describe("OpenAI image request deadlines", () => {
  it("aborts a stalled generation at the injected deadline", async () => {
    await expect(
      handleImageGenerationWithFetch(
        createRuntime(),
        { prompt: "draw a bounded request" },
        stallUntilAborted(),
        10,
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed generation", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("quota exceeded", { status: 429, statusText: "Too Many Requests" });

    await expect(
      handleImageGenerationWithFetch(
        createRuntime(),
        { prompt: "draw a bounded request" },
        fetchImpl,
        1_000,
      ),
    ).rejects.toThrow("quota exceeded");
  });

  it("uses the injected fetch for a successful generation", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json({
        data: [{ url: "https://images.invalid/result.png", revised_prompt: "a bounded sketch" }],
      });
    };

    const images = await handleImageGenerationWithFetch(
      createRuntime(),
      { prompt: "draw a bounded request" },
      fetchImpl,
      1_000,
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(images).toEqual([
      { url: "https://images.invalid/result.png", revisedPrompt: "a bounded sketch" },
    ]);
  });

  it("aborts a stalled description at the injected deadline", async () => {
    await expect(
      handleImageDescriptionWithFetch(
        createRuntime(),
        "https://images.invalid/prove.png",
        stallUntilAborted(),
        10,
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed description", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("vision quota exceeded", { status: 429, statusText: "Too Many Requests" });

    await expect(
      handleImageDescriptionWithFetch(
        createRuntime(),
        "https://images.invalid/prove.png",
        fetchImpl,
        1_000,
      ),
    ).rejects.toThrow("vision quota exceeded");
  });

  it("uses the injected fetch for a successful description", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json({
        choices: [{ message: { content: "title: Bounded\nA sketch that finished." } }],
      });
    };

    const result = await handleImageDescriptionWithFetch(
      createRuntime(),
      "https://images.invalid/prove.png",
      fetchImpl,
      1_000,
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(result.title).toBe("Bounded");
    expect(result.description).toContain("A sketch that finished.");
  });
});
