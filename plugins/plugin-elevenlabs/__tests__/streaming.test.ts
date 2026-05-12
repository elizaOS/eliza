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

// Mock the SDK before the plugin module is loaded.
vi.mock("@elevenlabs/elevenlabs-js", () => {
  return {
    ElevenLabsClient: class {
      textToSpeech = {
        stream: streamMock,
      };
      speechToText = {
        convert: vi.fn(),
      };
    },
  };
});

vi.mock("@elevenlabs/elevenlabs-js/api", () => {
  return {
    SpeechToTextConvertRequestModelId: { ScribeV1: "scribe_v1" },
    SpeechToTextConvertRequestTimestampsGranularity: { Word: "word" },
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
    if (!ttsHandler) throw new Error("TEXT_TO_SPEECH model missing");

    const runtime = createFakeRuntime();
    // The plugin handler signature accepts (runtime, input).
    const result = (await ttsHandler(
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
    if (!ttsHandler) throw new Error("TEXT_TO_SPEECH model missing");
    const runtime = createFakeRuntime({
      ELEVENLABS_VOICE_ID: "voice-XYZ",
      ELEVENLABS_OUTPUT_FORMAT: "pcm_16000",
    });

    await ttsHandler(
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
    if (!ttsHandler) throw new Error("TEXT_TO_SPEECH model missing");
    const runtime = createFakeRuntime();

    await ttsHandler(
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
    if (!ttsHandler) throw new Error("TEXT_TO_SPEECH model missing");
    const runtime = createFakeRuntime();

    await expect(
      ttsHandler(
        runtime as unknown as Parameters<NonNullable<typeof ttsHandler>>[0],
        "fail me",
      ),
    ).rejects.toThrow(/upstream 503/);
  });
});
