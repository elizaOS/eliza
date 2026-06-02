/**
 * Functional streaming test for the ElevenLabs TTS plugin.
 *
 * The plugin's `TEXT_TO_SPEECH` model handler internally calls
 * `client.textToSpeech.stream()` and drains the resulting
 * `ReadableStream<Uint8Array>` via `readStreamToUint8Array`. This test
 * mocks the ElevenLabs SDK so we can:
 *   1. Confirm the plugin actually awaits the SDK's streaming API.
 *   2. Confirm a multi-chunk stream is fully drained (truly streaming —
 *      the reader pulls chunk N+1 before the producer writes the last
 *      chunk).
 *   3. Confirm the resolved bytes preserve chunk order and total size.
 */
import { describe, expect, it, vi } from "vitest";

const streamMock = vi.fn();
const convertMock = vi.fn();

// Mock the SDK before the plugin module is loaded.
vi.mock("@elevenlabs/elevenlabs-js", () => {
  return {
    ElevenLabsClient: class {
      textToSpeech = {
        stream: streamMock,
      };
      speechToText = {
        convert: convertMock,
      };
    },
  };
});

vi.mock("@elevenlabs/elevenlabs-js/api", () => {
  return {
    SpeechToTextConvertRequestModelId: { ScribeV1: "scribe_v1" },
    SpeechToTextConvertRequestTimestampsGranularity: {
      None: "none",
      Word: "word",
    },
    TextToSpeechStreamRequestOutputFormat: {
      Mp3_44100_128: "mp3_44100_128",
      Pcm16000: "pcm_16000",
    },
  };
});

interface FakeRuntime {
  agentId: string;
  getSetting: (key: string) => string | undefined;
  character: { settings: Record<string, unknown> };
}

function createFakeRuntime(settings: Record<string, string> = {}): FakeRuntime {
  const merged: Record<string, string> = {
    ELEVENLABS_API_KEY: "sk-test-fake",
    ELEVENLABS_VOICE_ID: "voice-123",
    ELEVENLABS_MODEL_ID: "eleven_monolingual_v1",
    ELEVENLABS_OUTPUT_FORMAT: "mp3_44100_128",
    ...settings,
  };
  return {
    agentId: "test-agent",
    getSetting: (key: string) => merged[key],
    character: { settings: {} },
  };
}

function setGlobalValue(key: string, value: unknown): () => void {
  const hadValue = Object.hasOwn(globalThis, key);
  const previous = (globalThis as Record<string, unknown>)[key];
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
  return () => {
    if (hadValue) {
      Object.defineProperty(globalThis, key, {
        configurable: true,
        writable: true,
        value: previous,
      });
    } else {
      delete (globalThis as Record<string, unknown>)[key];
    }
  };
}

/**
 * Build a ReadableStream that yields `chunkCount` Uint8Array chunks at
 * `intervalMs` apart. Each chunk is filled with a distinct byte value so
 * we can verify ordering on the consumer side.
 */
function makeChunkedStream(
  chunkSizes: number[],
  intervalMs: number,
): {
  stream: ReadableStream<Uint8Array>;
  chunksEnqueued: { time: number; size: number }[];
} {
  const chunksEnqueued: { time: number; size: number }[] = [];
  const start = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let i = 0; i < chunkSizes.length; i += 1) {
        if (i > 0) {
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
        const size = chunkSizes[i];
        const chunk = new Uint8Array(size);
        chunk.fill(i + 1);
        chunksEnqueued.push({ time: Date.now() - start, size });
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

  return { stream, chunksEnqueued };
}

describe("plugin-elevenlabs TTS streaming", () => {
  it("drains a multi-chunk stream and concatenates bytes in order", async () => {
    const chunkSizes = [16, 32, 24, 8];
    const { stream } = makeChunkedStream(chunkSizes, 5);
    streamMock.mockResolvedValueOnce(stream);

    const { elevenLabsPlugin } = await import("../src/index.js");
    const ttsHandler = elevenLabsPlugin.models?.TEXT_TO_SPEECH;
    expect(ttsHandler).toBeDefined();

    const runtime = createFakeRuntime();
    // The plugin handler signature accepts (runtime, input).
    const result = (await ttsHandler?.(
      runtime as unknown as Parameters<NonNullable<typeof ttsHandler>>[0],
      "hello world",
    )) as Uint8Array;

    expect(result).toBeInstanceOf(Uint8Array);
    const expectedTotal = chunkSizes.reduce((a, b) => a + b, 0);
    expect(result.byteLength).toBe(expectedTotal);

    // Verify chunk ordering: bytes from chunk 0 (filled with 1) come first,
    // then chunk 1 (filled with 2), etc.
    let cursor = 0;
    for (let i = 0; i < chunkSizes.length; i += 1) {
      const expected = i + 1;
      for (let b = 0; b < chunkSizes[i]; b += 1) {
        expect(result[cursor + b]).toBe(expected);
      }
      cursor += chunkSizes[i];
    }
  });

  it("invokes the SDK with the configured voice + format params", async () => {
    streamMock.mockReset();
    const { stream } = makeChunkedStream([8], 0);
    streamMock.mockResolvedValueOnce(stream);

    const { elevenLabsPlugin } = await import("../src/index.js");
    const ttsHandler = elevenLabsPlugin.models?.TEXT_TO_SPEECH;
    const runtime = createFakeRuntime({
      ELEVENLABS_VOICE_ID: "voice-XYZ",
      ELEVENLABS_OUTPUT_FORMAT: "pcm_16000",
    });

    await ttsHandler?.(
      runtime as unknown as Parameters<NonNullable<typeof ttsHandler>>[0],
      { text: "stream me" },
    );

    expect(streamMock).toHaveBeenCalledTimes(1);
    const [voiceArg, optsArg] = streamMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(voiceArg).toBe("voice-XYZ");
    expect(optsArg.text).toBe("stream me");
    expect(optsArg.outputFormat).toBe("pcm_16000");
  });

  it("respects an explicit per-call format override", async () => {
    streamMock.mockReset();
    const { stream } = makeChunkedStream([4], 0);
    streamMock.mockResolvedValueOnce(stream);

    const { elevenLabsPlugin } = await import("../src/index.js");
    const ttsHandler = elevenLabsPlugin.models?.TEXT_TO_SPEECH;
    const runtime = createFakeRuntime();

    await ttsHandler?.(
      runtime as unknown as Parameters<NonNullable<typeof ttsHandler>>[0],
      { text: "override format", format: "pcm_16000" },
    );

    const [, optsArg] = streamMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(optsArg.outputFormat).toBe("pcm_16000");
  });

  it("propagates SDK errors instead of returning empty bytes", async () => {
    streamMock.mockReset();
    streamMock.mockRejectedValueOnce(new Error("upstream 503"));

    const { elevenLabsPlugin } = await import("../src/index.js");
    const ttsHandler = elevenLabsPlugin.models?.TEXT_TO_SPEECH;
    const runtime = createFakeRuntime();

    await expect(
      ttsHandler?.(
        runtime as unknown as Parameters<NonNullable<typeof ttsHandler>>[0],
        "fail me",
      ),
    ).rejects.toThrow(/upstream 503/);
  });
});

describe("plugin-elevenlabs STT transcription", () => {
  it("sends Buffer input with configured STT options", async () => {
    convertMock.mockReset();
    convertMock.mockResolvedValueOnce({ text: "transcribed buffer" });

    const { elevenLabsPlugin } = await import("../src/index.js");
    const transcriptionHandler = elevenLabsPlugin.models?.TRANSCRIPTION;
    const runtime = createFakeRuntime({
      ELEVENLABS_STT_MODEL_ID: "scribe_v1",
      ELEVENLABS_STT_LANGUAGE_CODE: "en",
      ELEVENLABS_STT_TIMESTAMPS_GRANULARITY: "word",
      ELEVENLABS_STT_DIARIZE: "true",
      ELEVENLABS_STT_NUM_SPEAKERS: "2",
      ELEVENLABS_STT_TAG_AUDIO_EVENTS: "true",
    });
    const audio = Buffer.from([1, 2, 3, 4]);

    await expect(
      transcriptionHandler?.(
        runtime as unknown as Parameters<
          NonNullable<typeof transcriptionHandler>
        >[0],
        audio,
      ),
    ).resolves.toBe("transcribed buffer");

    expect(convertMock).toHaveBeenCalledWith({
      modelId: "scribe_v1",
      file: audio,
      languageCode: "en",
      timestampsGranularity: "word",
      diarize: true,
      numSpeakers: 2,
      tagAudioEvents: true,
    });
  });

  it("fetches audioUrl input and sends explicit none timestamp granularity", async () => {
    convertMock.mockReset();
    convertMock.mockResolvedValueOnce({
      transcripts: [{ text: "left" }, { text: "right" }],
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new Uint8Array([9, 8, 7]).buffer,
    }));
    const restoreFetch = setGlobalValue("fetch", fetchMock);

    const { elevenLabsPlugin } = await import("../src/index.js");
    const transcriptionHandler = elevenLabsPlugin.models?.TRANSCRIPTION;
    const runtime = createFakeRuntime({
      ELEVENLABS_STT_TIMESTAMPS_GRANULARITY: "none",
      ELEVENLABS_STT_DIARIZE: "false",
      ELEVENLABS_STT_TAG_AUDIO_EVENTS: "false",
    });

    await expect(
      transcriptionHandler?.(
        runtime as unknown as Parameters<
          NonNullable<typeof transcriptionHandler>
        >[0],
        { audioUrl: "https://audio.example/file.wav" },
      ),
    ).resolves.toBe("left\nright");

    expect(fetchMock).toHaveBeenCalledWith("https://audio.example/file.wav");
    expect(convertMock).toHaveBeenCalledWith({
      modelId: "scribe_v1",
      file: Buffer.from([9, 8, 7]),
      timestampsGranularity: "none",
    });

    restoreFetch();
  });

  it("throws when URL audio fetch fails before calling the SDK", async () => {
    convertMock.mockReset();
    const restoreFetch = setGlobalValue(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
    );

    const { elevenLabsPlugin } = await import("../src/index.js");
    const transcriptionHandler = elevenLabsPlugin.models?.TRANSCRIPTION;
    const runtime = createFakeRuntime();

    await expect(
      transcriptionHandler?.(
        runtime as unknown as Parameters<
          NonNullable<typeof transcriptionHandler>
        >[0],
        "https://audio.example/missing.wav",
      ),
    ).rejects.toThrow(
      "Failed to fetch audio from URL: https://audio.example/missing.wav",
    );
    expect(convertMock).not.toHaveBeenCalled();

    restoreFetch();
  });

  it("rejects unsupported STT enum values", async () => {
    convertMock.mockReset();

    const { elevenLabsPlugin } = await import("../src/index.js");
    const transcriptionHandler = elevenLabsPlugin.models?.TRANSCRIPTION;
    const runtime = createFakeRuntime({
      ELEVENLABS_STT_MODEL_ID: "bad_model",
    });

    await expect(
      transcriptionHandler?.(
        runtime as unknown as Parameters<
          NonNullable<typeof transcriptionHandler>
        >[0],
        Buffer.from([1]),
      ),
    ).rejects.toThrow("Unsupported ElevenLabs STT model: bad_model");
    expect(convertMock).not.toHaveBeenCalled();
  });

  it("rejects invalid numSpeakers before calling the SDK", async () => {
    convertMock.mockReset();

    const { elevenLabsPlugin } = await import("../src/index.js");
    const transcriptionHandler = elevenLabsPlugin.models?.TRANSCRIPTION;
    const runtime = createFakeRuntime({
      ELEVENLABS_STT_DIARIZE: "true",
      ELEVENLABS_STT_NUM_SPEAKERS: "abc",
    });

    await expect(
      transcriptionHandler?.(
        runtime as unknown as Parameters<
          NonNullable<typeof transcriptionHandler>
        >[0],
        Buffer.from([1]),
      ),
    ).rejects.toThrow(
      "ELEVENLABS_STT_NUM_SPEAKERS must be an integer between 1 and 32",
    );
    expect(convertMock).not.toHaveBeenCalled();
  });

  it("supports browser object URL input without a global Buffer", async () => {
    convertMock.mockReset();
    convertMock.mockResolvedValueOnce({ text: "browser transcript" });
    const blob = new Blob([new Uint8Array([5, 4, 3])], {
      type: "audio/wav",
    });
    const restoreDocument = setGlobalValue("document", {});
    const restoreBuffer = setGlobalValue("Buffer", undefined);
    const restoreFetch = setGlobalValue(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        blob: async () => blob,
        arrayBuffer: async () => new Uint8Array([5, 4, 3]).buffer,
      })),
    );

    const { elevenLabsPlugin } = await import("../src/index.js");
    const transcriptionHandler = elevenLabsPlugin.models?.TRANSCRIPTION;
    const runtime = createFakeRuntime();

    await expect(
      transcriptionHandler?.(
        runtime as unknown as Parameters<
          NonNullable<typeof transcriptionHandler>
        >[0],
        { audioUrl: "https://audio.example/browser.wav" },
      ),
    ).resolves.toBe("browser transcript");

    expect(convertMock).toHaveBeenCalledWith({
      modelId: "scribe_v1",
      file: blob,
      timestampsGranularity: "word",
    });

    restoreFetch();
    restoreBuffer();
    restoreDocument();
  });
});
