/** Exercises OpenAI embedding deadlines and caller cancellation with deterministic fetches. */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    toWellFormedUnicode: (text: string) => text,
    truncateWellFormed: (text: string) => text,
  };
});

import { handleTextEmbedding } from "../models/embedding";

const DIM = 384;

function createRuntime(): IAgentRuntime {
  return {
    character: { name: "Embedding timeout" },
    getSetting(key: string) {
      const values: Record<string, string> = {
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: "https://api.openai.invalid/v1",
        OPENAI_EMBEDDING_DIMENSIONS: String(DIM),
      };
      return values[key];
    },
  } as unknown as IAgentRuntime;
}

function vector(): number[] {
  return Array.from({ length: DIM }, (_, index) => (index === 0 ? 0.1 : 0));
}

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected embedding abort signal");
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

describe("OpenAI embedding request deadlines", () => {
  it("aborts a stalled request at its deadline", async () => {
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSoon());
    vi.spyOn(globalThis, "fetch").mockImplementation(stallUntilAborted());
    await expect(handleTextEmbedding(createRuntime(), "embed this")).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(AbortSignal.timeout).toHaveBeenCalledWith(30_000);
  });

  it("preserves caller cancellation", async () => {
    const caller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
    vi.spyOn(globalThis, "fetch").mockImplementation(stallUntilAborted());
    const pending = handleTextEmbedding(createRuntime(), {
      text: "embed this",
      signal: caller.signal,
    });
    caller.abort(new DOMException("Cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("surfaces a completed provider error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("quota exceeded", { status: 429, statusText: "Too Many Requests" })
    );
    await expect(handleTextEmbedding(createRuntime(), "embed this")).rejects.toThrow(
      "quota exceeded"
    );
  });

  it("keeps successful embedding behavior", async () => {
    const embedding = vector();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [{ embedding }] }));
    await expect(handleTextEmbedding(createRuntime(), "embed this")).resolves.toEqual(embedding);
  });
});
