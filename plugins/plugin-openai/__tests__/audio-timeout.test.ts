/** Exercises OpenAI audio request deadlines with deterministic fetch collaborators. */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTextToSpeech, handleTranscription } from "../models/audio";

function createRuntime(): IAgentRuntime {
  return {
    character: { name: "Audio timeout" },
    getSetting(key: string) {
      const values: Record<string, string> = {
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: "https://api.openai.invalid/v1",
      };
      return values[key];
    },
  } as unknown as IAgentRuntime;
}

function clip(): Blob {
  return new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
}

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected audio abort signal");
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

describe("OpenAI audio request deadlines", () => {
  it("aborts a stalled transcription at its deadline", async () => {
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSoon());
    vi.spyOn(globalThis, "fetch").mockImplementation(stallUntilAborted());
    await expect(handleTranscription(createRuntime(), clip())).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(AbortSignal.timeout).toHaveBeenCalledWith(120_000);
  });

  it("preserves caller cancellation for transcription", async () => {
    const caller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
    vi.spyOn(globalThis, "fetch").mockImplementation(stallUntilAborted());
    const input = { audio: clip(), signal: caller.signal } as Parameters<
      typeof handleTranscription
    >[1];
    const pending = handleTranscription(createRuntime(), input);
    caller.abort(new DOMException("Cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("surfaces a completed transcription provider error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("quota exceeded", { status: 429, statusText: "Too Many Requests" })
    );
    await expect(handleTranscription(createRuntime(), clip())).rejects.toThrow("quota exceeded");
  });

  it("keeps successful transcription behavior", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ text: "a bounded transcript" })
    );
    await expect(handleTranscription(createRuntime(), clip())).resolves.toBe(
      "a bounded transcript"
    );
  });

  it("aborts a stalled TTS request at its deadline", async () => {
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSoon());
    vi.spyOn(globalThis, "fetch").mockImplementation(stallUntilAborted());
    await expect(handleTextToSpeech(createRuntime(), "say a bounded line")).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(AbortSignal.timeout).toHaveBeenCalledWith(60_000);
  });

  it("preserves caller cancellation for TTS", async () => {
    const caller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
    vi.spyOn(globalThis, "fetch").mockImplementation(stallUntilAborted());
    const pending = handleTextToSpeech(createRuntime(), {
      text: "say a bounded line",
      signal: caller.signal,
    });
    caller.abort(new DOMException("Cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("surfaces a completed TTS provider error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("speech quota exceeded", { status: 429, statusText: "Too Many Requests" })
    );
    await expect(handleTextToSpeech(createRuntime(), "say a bounded line")).rejects.toThrow(
      "speech quota exceeded"
    );
  });

  it("keeps successful TTS behavior", async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(bytes, { headers: { "content-type": "audio/mpeg" } })
    );
    const audio = await handleTextToSpeech(createRuntime(), "say a bounded line");
    expect(new Uint8Array(audio)).toEqual(bytes);
  });
});
