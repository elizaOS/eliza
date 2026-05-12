import { describe, expect, it } from "vitest";
import { KokoroTtsBackend } from "../kokoro-backend";
import { KokoroMockRuntime } from "../kokoro-runtime";
import type { KokoroPhonemizer } from "../types";
import { KOKORO_DEFAULT_VOICE_ID } from "../voices";
import type {
  AudioSink,
  Phrase,
  SpeakerPreset,
  TtsPcmChunk,
} from "../../types";

function fixedPhonemizer(): KokoroPhonemizer {
  return {
    id: "fixed",
    async phonemize() {
      return { ids: Int32Array.from([1, 43, 60, 2]), phonemes: "ab" };
    },
  };
}

function makePreset(voiceId: string): SpeakerPreset {
  return {
    voiceId,
    embedding: new Float32Array(8),
    bytes: new Uint8Array(8),
  };
}

function makePhrase(text: string): Phrase {
  return {
    id: 1,
    text,
    fromIndex: 0,
    toIndex: text.length - 1,
    terminator: "punctuation",
  };
}

function makeBackend(opts?: {
  totalSamples?: number;
  chunkCount?: number;
}): { backend: KokoroTtsBackend; runtime: KokoroMockRuntime } {
  const runtime = new KokoroMockRuntime({
    sampleRate: 24000,
    totalSamples: opts?.totalSamples ?? 9600, // 0.4s
    chunkCount: opts?.chunkCount ?? 4,
  });
  const backend = new KokoroTtsBackend({
    runtime,
    layout: {
      root: "/tmp/kokoro",
      modelFile: "model.onnx",
      voicesDir: "/tmp/kokoro/voices",
      sampleRate: 24000,
    },
    defaultVoiceId: KOKORO_DEFAULT_VOICE_ID,
    phonemizer: fixedPhonemizer(),
    streamingChunkSamples: 1200, // 50ms — re-chunks the mock output
  });
  return { backend, runtime };
}

describe("KokoroTtsBackend", () => {
  it("streams PCM chunks and emits a zero-length final tail", async () => {
    const { backend, runtime } = makeBackend({ totalSamples: 9600, chunkCount: 4 });
    const chunks: TtsPcmChunk[] = [];
    const result = await backend.synthesizeStream({
      phrase: makePhrase("hello"),
      preset: makePreset(KOKORO_DEFAULT_VOICE_ID),
      cancelSignal: { cancelled: false },
      onChunk: (c) => {
        chunks.push({
          pcm: new Float32Array(c.pcm),
          sampleRate: c.sampleRate,
          isFinal: c.isFinal,
        });
        return undefined;
      },
    });
    expect(result.cancelled).toBe(false);
    expect(runtime.calls).toBe(1);
    expect(chunks.length).toBeGreaterThan(1);
    const last = chunks[chunks.length - 1];
    expect(last).toBeDefined();
    expect(last?.isFinal).toBe(true);
    expect(last?.pcm.length).toBe(0);
    const bodyChunks = chunks.slice(0, -1);
    expect(bodyChunks.every((c) => !c.isFinal)).toBe(true);
    expect(bodyChunks.every((c) => c.sampleRate === 24000)).toBe(true);
    // Re-chunking honoured: every body chunk respects the 1200-sample cap.
    expect(bodyChunks.every((c) => c.pcm.length <= 1200)).toBe(true);
    const totalBody = bodyChunks.reduce((n, c) => n + c.pcm.length, 0);
    expect(totalBody).toBe(9600);
  });

  it("propagates cancelSignal at chunk boundaries", async () => {
    const { backend } = makeBackend({ totalSamples: 24000, chunkCount: 8 });
    const cancelSignal = { cancelled: false };
    let received = 0;
    const result = await backend.synthesizeStream({
      phrase: makePhrase("a longer line"),
      preset: makePreset(KOKORO_DEFAULT_VOICE_ID),
      cancelSignal,
      onChunk: (c) => {
        if (!c.isFinal) {
          received++;
          if (received === 2) cancelSignal.cancelled = true;
        }
        return undefined;
      },
    });
    expect(result.cancelled).toBe(true);
    // Final tail is always emitted, even on cancel.
    // received counts body chunks only; the runtime stops once cancelled.
    expect(received).toBeLessThanOrEqual(3);
  });

  it("synthesize() concatenates streamed chunks into one AudioChunk", async () => {
    const { backend } = makeBackend({ totalSamples: 9600, chunkCount: 4 });
    const chunk = await backend.synthesize({
      phrase: makePhrase("hi"),
      preset: makePreset(KOKORO_DEFAULT_VOICE_ID),
      cancelSignal: { cancelled: false },
    });
    expect(chunk.sampleRate).toBe(24000);
    expect(chunk.pcm.length).toBe(9600);
    expect(chunk.phraseId).toBe(1);
  });

  it("falls back to the default voice when preset.voiceId is unknown", async () => {
    const { backend } = makeBackend();
    const chunk = await backend.synthesize({
      phrase: makePhrase("hi"),
      preset: makePreset("does_not_exist"),
      cancelSignal: { cancelled: false },
    });
    expect(chunk.pcm.length).toBeGreaterThan(0);
  });

  it("supportsStreamingTts() returns true (satisfies the streaming seam)", () => {
    const { backend } = makeBackend();
    expect(backend.supportsStreamingTts()).toBe(true);
  });
});

// Local declaration so the test file does not import the audio sink (unused).
void (null as unknown as AudioSink);
