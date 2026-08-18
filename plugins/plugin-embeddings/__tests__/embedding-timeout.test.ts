/** Exercises embedding deadlines, cancellation, and fallback with deterministic fetches. */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTextEmbedding } from "../src/models/embedding";

const DIM = 384;

function createRuntime(settings: Record<string, string> = {}): IAgentRuntime {
  const values: Record<string, string> = {
    EMBEDDING_BASE_URL: "https://primary.invalid/v1",
    EMBEDDING_API_KEY: "test-key",
    EMBEDDING_DIMENSIONS: String(DIM),
    ...settings,
  };
  return {
    character: { name: "Embeddings timeout" },
    emitEvent: vi.fn(async () => undefined),
    getSetting(key: string) {
      return values[key];
    },
  } as unknown as IAgentRuntime;
}

function vector(): number[] {
  return Array.from({ length: DIM }, (_, index) => (index === 0 ? 0.1 : 0));
}

function stallUntilAborted(): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = (vi.mocked(globalThis.fetch).mock.calls.at(-1)?.[1] as RequestInit | undefined)
      ?.signal;
    if (!signal) throw new Error("expected embedding abort signal");
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function timeoutSoon(): AbortSignal {
  const controller = new AbortController();
  queueMicrotask(() => controller.abort(new DOMException("Timed out", "TimeoutError")));
  return controller.signal;
}

afterEach(() => vi.restoreAllMocks());

describe("plugin-embeddings request deadlines", () => {
  it("bounds a stalled request", async () => {
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSoon());
    vi.spyOn(globalThis, "fetch").mockImplementation(() => stallUntilAborted());
    await expect(handleTextEmbedding(createRuntime(), "embed this")).rejects.toMatchObject({
      cause: { name: "TimeoutError" },
    });
    expect(AbortSignal.timeout).toHaveBeenCalledWith(30_000);
  });

  it("preserves caller cancellation", async () => {
    const caller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
    vi.spyOn(globalThis, "fetch").mockImplementation(() => stallUntilAborted());
    const pending = handleTextEmbedding(createRuntime(), {
      text: "embed this",
      signal: caller.signal,
    });
    caller.abort(new DOMException("Cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("retries the fallback with a fresh deadline after primary timeout", async () => {
    const embedding = vector();
    vi.spyOn(AbortSignal, "timeout")
      .mockReturnValueOnce(timeoutSoon())
      .mockReturnValueOnce(new AbortController().signal);
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => stallUntilAborted())
      .mockResolvedValueOnce(Response.json({ data: [{ embedding, index: 0 }] }));

    await expect(
      handleTextEmbedding(
        createRuntime({ EMBEDDING_FALLBACK_BASE_URL: "https://fallback.invalid/v1" }),
        "embed this"
      )
    ).resolves.toEqual(embedding);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(AbortSignal.timeout).toHaveBeenCalledTimes(2);
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
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ data: [{ embedding, index: 0 }] })
    );
    await expect(handleTextEmbedding(createRuntime(), "embed this")).resolves.toEqual(embedding);
  });
});
