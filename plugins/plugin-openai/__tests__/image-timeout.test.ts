/** Exercises OpenAI image request deadlines with deterministic fetch collaborators. */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleImageDescription, handleImageGeneration } from "../models/image";

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
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as typeof fetch;
}

function timeoutSoon(): AbortSignal {
  const controller = new AbortController();
  queueMicrotask(() => controller.abort(new DOMException("Timed out", "TimeoutError")));
  return controller.signal;
}

afterEach(() => vi.restoreAllMocks());

describe("OpenAI image request deadlines", () => {
  it("aborts a stalled generation at its deadline", async () => {
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSoon());
    vi.spyOn(globalThis, "fetch").mockImplementation(stallUntilAborted());
    await expect(
      handleImageGeneration(createRuntime(), { prompt: "draw a bounded request" })
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(AbortSignal.timeout).toHaveBeenCalledWith(120_000);
  });

  it("surfaces a completed generation provider error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("quota exceeded", { status: 429, statusText: "Too Many Requests" })
    );
    await expect(
      handleImageGeneration(createRuntime(), { prompt: "draw a bounded request" })
    ).rejects.toThrow("quota exceeded");
  });

  it("keeps successful generation behavior", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: [{ url: "https://images.invalid/result.png", revised_prompt: "a bounded sketch" }],
      })
    );
    await expect(
      handleImageGeneration(createRuntime(), { prompt: "draw a bounded request" })
    ).resolves.toEqual([
      { url: "https://images.invalid/result.png", revisedPrompt: "a bounded sketch" },
    ]);
  });

  it("aborts a stalled description at its deadline", async () => {
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSoon());
    vi.spyOn(globalThis, "fetch").mockImplementation(stallUntilAborted());
    await expect(
      handleImageDescription(createRuntime(), "https://images.invalid/prove.png")
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(AbortSignal.timeout).toHaveBeenCalledWith(45_000);
  });

  it("preserves caller cancellation for descriptions", async () => {
    const caller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
    vi.spyOn(globalThis, "fetch").mockImplementation(stallUntilAborted());
    const pending = handleImageDescription(createRuntime(), {
      imageUrl: "https://images.invalid/prove.png",
      signal: caller.signal,
    });
    caller.abort(new DOMException("Cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("surfaces a completed description provider error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("vision quota exceeded", { status: 429, statusText: "Too Many Requests" })
    );
    await expect(
      handleImageDescription(createRuntime(), "https://images.invalid/prove.png")
    ).rejects.toThrow("vision quota exceeded");
  });

  it("keeps successful description behavior", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        choices: [{ message: { content: "title: Bounded\nA sketch that finished." } }],
      })
    );
    await expect(
      handleImageDescription(createRuntime(), "https://images.invalid/prove.png")
    ).resolves.toMatchObject({ title: "Bounded", description: "A sketch that finished." });
  });
});
