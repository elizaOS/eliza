/**
 * Behavioral deadlines for OpenAI transcription and TTS.
 * ASR upload and speech synth use separate named budgets (not one 30s fit-all).
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { handleTextToSpeechWithFetch, handleTranscriptionWithFetch } from "../models/audio";

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
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as typeof fetch;
}

describe("OpenAI audio request deadlines", () => {
  it("aborts a stalled transcription at the injected deadline", async () => {
    await expect(
      handleTranscriptionWithFetch(createRuntime(), clip(), stallUntilAborted(), 10)
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed transcription", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("quota exceeded", { status: 429, statusText: "Too Many Requests" });

    await expect(
      handleTranscriptionWithFetch(createRuntime(), clip(), fetchImpl, 1_000)
    ).rejects.toThrow("quota exceeded");
  });

  it("uses the injected fetch for a successful transcription", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json({ text: "a bounded transcript" });
    };

    const text = await handleTranscriptionWithFetch(createRuntime(), clip(), fetchImpl, 1_000);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(text).toBe("a bounded transcript");
  });

  it("aborts a stalled TTS request at the injected deadline", async () => {
    await expect(
      handleTextToSpeechWithFetch(createRuntime(), "say a bounded line", stallUntilAborted(), 10)
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed TTS request", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("speech quota exceeded", { status: 429, statusText: "Too Many Requests" });

    await expect(
      handleTextToSpeechWithFetch(createRuntime(), "say a bounded line", fetchImpl, 1_000)
    ).rejects.toThrow("speech quota exceeded");
  });

  it("uses the injected fetch for a successful TTS request", async () => {
    const signals: AbortSignal[] = [];
    const bytes = new Uint8Array([9, 8, 7]);
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return new Response(bytes, { headers: { "content-type": "audio/mpeg" } });
    };

    const audio = await handleTextToSpeechWithFetch(
      createRuntime(),
      "say a bounded line",
      fetchImpl,
      1_000
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(new Uint8Array(audio)).toEqual(bytes);
  });
});
