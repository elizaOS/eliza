/**
 * Shape test for the TRANSCRIPTION handler with a stubbed `fetch` (no live API):
 * verifies the handler registers, posts Buffer audio as base64 `input_audio`, and
 * fetches http `audioUrl` inputs while preserving the response content type.
 */
import { type IAgentRuntime, ModelType } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

function createRuntime(settings: Record<string, string | null> = {}) {
  const defaults: Record<string, string> = {
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
    OPENROUTER_TRANSCRIPTION_MODEL: "openai/whisper-large-v3",
  };

  return {
    emitEvent: vi.fn(async () => undefined),
    getSetting: vi.fn((key: string) => settings[key] ?? defaults[key] ?? null),
  } as unknown as IAgentRuntime;
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: vi.fn(async () => body),
    text: vi.fn(async () => JSON.stringify(body)),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("OpenRouter transcription", () => {
  it("registers a TRANSCRIPTION model handler", async () => {
    const { openrouterPlugin } = await import("../plugin");

    expect(openrouterPlugin.models?.[ModelType.TRANSCRIPTION]).toEqual(expect.any(Function));
  });

  it("posts Buffer audio as documented base64 input_audio", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        text: "transcribed buffer",
        usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
      })
    );
    vi.stubGlobal("fetch", fetch);
    const { handleTranscription } = await import("../models/audio");
    const runtime = createRuntime();

    await expect(handleTranscription(runtime, Buffer.from("ID3audio"))).resolves.toBe(
      "transcribed buffer"
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://openrouter.test/api/v1/audio/transcriptions",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        },
      })
    );
    const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string);
    expect(body).toEqual({
      model: "openai/whisper-large-v3",
      input_audio: {
        data: Buffer.from("ID3audio").toString("base64"),
        format: "mp3",
      },
    });
    expect(runtime.emitEvent).toHaveBeenCalled();
  });

  it("fetches http audioUrl input and preserves response content type", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
        headers: { get: vi.fn(() => "audio/wav") },
      })
      .mockResolvedValueOnce(jsonResponse({ text: "transcribed url" }));
    vi.stubGlobal("fetch", fetch);
    const { handleTranscription } = await import("../models/audio");

    await expect(
      handleTranscription(createRuntime(), {
        audioUrl: "https://audio.example.test/input.wav",
      })
    ).resolves.toBe("transcribed url");

    expect(fetch).toHaveBeenNthCalledWith(1, "https://audio.example.test/input.wav");
    const body = JSON.parse(fetch.mock.calls[1]?.[1]?.body as string);
    expect(body.input_audio).toEqual({
      data: Buffer.from([1, 2, 3]).toString("base64"),
      format: "wav",
    });
  });

  it("rejects non-http audioUrl input before fetching", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { handleTranscription } = await import("../models/audio");

    await expect(
      handleTranscription(createRuntime(), { audioUrl: "file:///tmp/audio.wav" })
    ).rejects.toThrow("TRANSCRIPTION audioUrl must use http or https");
    expect(fetch).not.toHaveBeenCalled();
  });
});
