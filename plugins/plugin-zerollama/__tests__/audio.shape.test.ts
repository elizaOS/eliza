/**
 * Shape tests for Ollama TTS/STT config gates and OpenAI-compatible audio calls.
 * Fetch is mocked — no live Ollama daemon.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleTextToSpeech, handleTranscription } from "../models/audio";
import {
  getTranscriptionModel,
  getTtsModel,
  getTtsSpeed,
  getTtsVoice,
  isOllamaTranscriptionEnabled,
  isOllamaTtsEnabled,
} from "../utils/config";

vi.mock("@elizaos/core", async () => {
  const actual = await vi.importActual<typeof import("@elizaos/core")>("@elizaos/core");
  return {
    ...actual,
    recordLlmCall: vi.fn(async (_runtime, details, fn) => fn(details)),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

function runtime(settings: Record<string, string | undefined> = {}): IAgentRuntime {
  return {
    getSetting: vi.fn((key: string) => settings[key] ?? null),
  } as unknown as IAgentRuntime;
}

describe("Ollama audio config", () => {
  it("treats unset TTS/STT models as disabled", () => {
    const rt = runtime({});
    expect(isOllamaTtsEnabled(rt)).toBe(false);
    expect(isOllamaTranscriptionEnabled(rt)).toBe(false);
    expect(getTtsModel(rt)).toBe("");
    expect(getTranscriptionModel(rt)).toBe("");
  });

  it("resolves TTS model/voice/speed and ASR aliases", () => {
    const rt = runtime({
      OLLAMA_TTS_MODEL: " piper-en ",
      OLLAMA_TTS_VOICE: " alloy ",
      OLLAMA_TTS_SPEED: "1.5",
      OLLAMA_ASR_MODEL: " whisper-base ",
    });
    expect(isOllamaTtsEnabled(rt)).toBe(true);
    expect(getTtsModel(rt)).toBe("piper-en");
    expect(getTtsVoice(rt)).toBe("alloy");
    expect(getTtsSpeed(rt)).toBe(1.5);
    expect(getTranscriptionModel(rt)).toBe("whisper-base");
    expect(isOllamaTranscriptionEnabled(rt)).toBe(true);
  });

  it("rejects out-of-range TTS speed", () => {
    expect(getTtsSpeed(runtime({ OLLAMA_TTS_SPEED: "9" }))).toBeUndefined();
  });
});

describe("Ollama audio handlers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when TTS model is unset", async () => {
    await expect(handleTextToSpeech(runtime({}), "hi")).rejects.toThrow(/OLLAMA_TTS_MODEL/);
  });

  it("POSTs /v1/audio/speech and returns audio bytes", async () => {
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    const fetchMock = vi.fn(async () => new Response(wav, { status: 200 }));
    const rt = {
      ...runtime({
        OLLAMA_BASE_URL: "http://remote:2083",
        OLLAMA_TTS_MODEL: "piper-en",
        OLLAMA_TTS_VOICE: "alloy",
      }),
      fetch: fetchMock,
    } as unknown as IAgentRuntime & { fetch: typeof fetch };

    const audio = await handleTextToSpeech(rt, "Hello");
    expect(audio.byteLength).toBe(wav.byteLength);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://remote:2083/v1/audio/speech",
      expect.objectContaining({ method: "POST" })
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      model: "piper-en",
      input: "Hello",
      response_format: "wav",
      voice: "alloy",
    });
  });

  it("treats Piper voice tags passed as model as the voice field", async () => {
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    const fetchMock = vi.fn(async () => new Response(wav, { status: 200 }));
    const rt = {
      ...runtime({
        OLLAMA_BASE_URL: "http://remote:2083",
        OLLAMA_TTS_MODEL: "piper-lessac:latest",
      }),
      fetch: fetchMock,
    } as unknown as IAgentRuntime & { fetch: typeof fetch };

    await handleTextToSpeech(rt, {
      text: "Hello",
      model: "en_US-female-medium",
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      model: "piper-lessac:latest",
      input: "Hello",
      response_format: "wav",
      voice: "en_US-female-medium",
    });
  });

  it("POSTs multipart /v1/audio/transcriptions", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ text: "hello world" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );
    const rt = {
      ...runtime({
        OLLAMA_BASE_URL: "http://remote:2083",
        OLLAMA_TRANSCRIPTION_MODEL: "whisper-base",
      }),
      fetch: fetchMock,
    } as unknown as IAgentRuntime & { fetch: typeof fetch };

    const pcm = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 1, 2, 3,
    ]);
    const text = await handleTranscription(rt, { audio: pcm });
    expect(text).toBe("hello world");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://remote:2083/v1/audio/transcriptions",
      expect.objectContaining({ method: "POST" })
    );
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(body).toBeInstanceOf(FormData);
  });
});
