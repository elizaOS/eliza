import { type IAgentRuntime, ModelType } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import groqPlugin, { classifyRetryError } from "../index";

function runtime(settings: Record<string, string | undefined> = {}): IAgentRuntime {
  return {
    character: { system: "system prompt" },
    emitEvent: vi.fn(),
    getService: vi.fn(),
    getSetting: (key: string) => settings[key],
  } as unknown as IAgentRuntime;
}

describe("@elizaos/plugin-groq behavior", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires GROQ_API_KEY during node init", async () => {
    await expect(groqPlugin.init?.({}, runtime())).rejects.toThrow("GROQ_API_KEY is required");
    await expect(
      groqPlugin.init?.({}, runtime({ GROQ_API_KEY: "gsk-test" }))
    ).resolves.toBeUndefined();
  });

  it("classifies retryable rate-limit and transient errors separately from fatal errors", () => {
    expect(classifyRetryError(new Error("Rate limit exceeded, try again in 2.5s"))).toBe(
      "rate-limit"
    );
    expect(classifyRetryError(new Error("fetch failed: ECONNRESET"))).toBe("transient");
    expect(classifyRetryError(new Error("invalid API key"))).toBe("fatal");
    expect(classifyRetryError("plain string")).toBe("fatal");
  });

  it("sends transcription requests with auth, model, and audio form data", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ text: "transcribed text" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      groqPlugin.models?.[ModelType.TRANSCRIPTION]?.(
        runtime({ GROQ_API_KEY: "gsk-test", GROQ_BASE_URL: "https://groq.test/v1" }),
        { audioData: new Uint8Array([1, 2, 3]) }
      )
    ).resolves.toBe("transcribed text");

    const [, init] = fetchMock.mock.calls[0];
    expect(fetchMock.mock.calls[0][0]).toBe("https://groq.test/v1/audio/transcriptions");
    expect(init).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer gsk-test" },
    });
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("model")).toBe("whisper-large-v3-turbo");
    expect((init.body as FormData).get("file")).toBeInstanceOf(File);
  });

  it("throws transcription response details on non-ok responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad audio", { status: 400, statusText: "Bad Request" }))
    );

    await expect(
      groqPlugin.models?.[ModelType.TRANSCRIPTION]?.(
        runtime({ GROQ_API_KEY: "gsk-test" }),
        Buffer.from("audio")
      )
    ).rejects.toThrow("Transcription failed: 400 bad audio");
  });

  it("sends text-to-speech requests with runtime and payload overrides", async () => {
    const bytes = new Uint8Array([10, 20, 30]).buffer;
    const fetchMock = vi.fn(async () => new Response(bytes, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      groqPlugin.models?.[ModelType.TEXT_TO_SPEECH]?.(
        runtime({
          GROQ_API_KEY: "gsk-test",
          GROQ_BASE_URL: "https://groq.test/v1",
          GROQ_TTS_MODEL: "runtime-model",
          GROQ_TTS_VOICE: "runtime-voice",
          GROQ_TTS_RESPONSE_FORMAT: "mp3",
        }),
        {
          text: "hello",
          model: "payload-model",
          voice: "payload-voice",
          response_format: "wav",
        }
      )
    ).resolves.toEqual(new Uint8Array([10, 20, 30]));

    expect(fetchMock).toHaveBeenCalledWith("https://groq.test/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: "Bearer gsk-test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "payload-model",
        voice: "payload-voice",
        input: "hello",
        response_format: "wav",
      }),
    });
  });

  it("keeps text-to-speech defaults aligned with plugin metadata", async () => {
    const bytes = new Uint8Array([10, 20, 30]).buffer;
    const fetchMock = vi.fn(async () => new Response(bytes, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      groqPlugin.models?.[ModelType.TEXT_TO_SPEECH]?.(runtime({ GROQ_API_KEY: "gsk-test" }), {
        text: "hello",
      })
    ).resolves.toEqual(new Uint8Array([10, 20, 30]));

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: "canopylabs/orpheus-v1-english",
      voice: "troy",
      input: "hello",
      response_format: "wav",
    });
  });
});
