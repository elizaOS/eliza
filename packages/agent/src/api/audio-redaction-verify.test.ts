/**
 * Covers fail-closed verifier adapters: runtime output validation, guarded
 * OpenAI-compatible transport, redirect refusal, and bounded JSON parsing.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  openAiCompatSttTranscriber,
  runtimeTranscriptionTranscriber,
} from "./audio-redaction-verify.ts";

const INPUT = {
  audio: new Uint8Array([1, 2, 3]),
  mimeType: "audio/wav",
};

describe("audio redaction verifier adapters", () => {
  it("rejects non-string and empty runtime model output", async () => {
    for (const output of [{ text: "looks plausible" }, "   "]) {
      const runtime = {
        useModel: vi.fn(async () => output),
      } as unknown as IAgentRuntime;
      await expect(
        runtimeTranscriptionTranscriber(runtime).transcribe(INPUT),
      ).rejects.toThrow(/no usable string transcript/);
    }
  });

  it("blocks literal internal STT targets before transport", async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"text":"secret"}', { status: 200 }),
    );
    const transcriber = openAiCompatSttTranscriber({
      baseUrl: "http://169.254.169.254",
      model: "whisper",
      fetchImpl,
    });
    await expect(transcriber.transcribe(INPUT)).rejects.toThrow(
      /STT verifier request failed/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never follows a credential-bearing redirect", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://other.example/transcribe" },
        }),
    );
    const transcriber = openAiCompatSttTranscriber({
      baseUrl: "https://example.com",
      model: "whisper",
      apiKey: "not-a-real-secret",
      fetchImpl,
    });
    await expect(transcriber.transcribe(INPUT)).rejects.toThrow(
      /request failed|HTTP 302/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("accepts a bounded JSON transcript and rejects malformed provider JSON", async () => {
    const good = openAiCompatSttTranscriber({
      baseUrl: "https://example.com",
      model: "whisper",
      fetchImpl: vi.fn(
        async () => new Response('{"text":"weather remains"}', { status: 200 }),
      ),
    });
    await expect(good.transcribe(INPUT)).resolves.toEqual({
      text: "weather remains",
    });

    const malformed = openAiCompatSttTranscriber({
      baseUrl: "https://example.com",
      model: "whisper",
      fetchImpl: vi.fn(async () => new Response("{", { status: 200 })),
    });
    await expect(malformed.transcribe(INPUT)).rejects.toThrow(/malformed JSON/);
  });
});
