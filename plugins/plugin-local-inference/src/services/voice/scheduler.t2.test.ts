/**
 * T2 — TTS chunk-size telemetry tests for `VoiceScheduler`.
 *
 * The scheduler streams TTS PCM in chunks; T2 records the per-phrase
 * distribution of chunk sizes so we can debug T1-class pathologies (one
 * giant chunk = no streaming) and confirm T3-class effects (more, smaller
 * phrases = more, smaller chunks). The streaming backend is a fake so
 * tests stay hermetic.
 */

import { describe, expect, it } from "vitest";
import { InMemoryAudioSink } from "./ring-buffer";
import { type TtsPhraseChunkMetrics, VoiceScheduler } from "./scheduler";
import type {
  AudioChunk,
  OmniVoiceBackend,
  Phrase,
  SpeakerPreset,
  StreamingTtsBackend,
  TextToken,
  TtsPcmChunk,
} from "./types";

function tok(index: number, text: string): TextToken {
  return { index, text };
}

function makePreset(): SpeakerPreset {
  const embedding = new Float32Array([0.1, 0.2]);
  return {
    voiceId: "default",
    embedding,
    bytes: new Uint8Array(embedding.buffer.slice(0)),
  };
}

class ScriptedStreamingBackend
  implements OmniVoiceBackend, StreamingTtsBackend
{
  constructor(private readonly chunks: ReadonlyArray<Float32Array>) {}
  async synthesize(): Promise<AudioChunk> {
    throw new Error("not used");
  }
  async synthesizeStream(args: {
    phrase: Phrase;
    preset: SpeakerPreset;
    cancelSignal: { cancelled: boolean };
    onChunk: (chunk: TtsPcmChunk) => boolean | undefined;
    onKernelTick?: () => void;
  }): Promise<{ cancelled: boolean }> {
    for (const pcm of this.chunks) {
      args.onKernelTick?.();
      if (args.cancelSignal.cancelled) break;
      args.onChunk({ pcm, sampleRate: 24000, isFinal: false });
    }
    args.onChunk({
      pcm: new Float32Array(0),
      sampleRate: 24000,
      isFinal: true,
    });
    return { cancelled: args.cancelSignal.cancelled };
  }
}

describe("VoiceScheduler T2 chunk-size telemetry", () => {
  it("emits one onChunkMetrics summary per phrase with per-chunk byte and duration", async () => {
    // 240 samples @ 24 kHz = 10 ms per chunk. Two chunks = 20 ms.
    const backend = new ScriptedStreamingBackend([
      new Float32Array(240),
      new Float32Array(480),
    ]);
    const sink = new InMemoryAudioSink();
    const metricsLog: TtsPhraseChunkMetrics[] = [];
    const sched = new VoiceScheduler(
      {
        chunkerConfig: { maxTokensPerPhrase: 10 },
        preset: makePreset(),
        ringBufferCapacity: 4096,
        sampleRate: 24000,
      },
      { backend, sink },
      { onChunkMetrics: (m) => metricsLog.push(m) },
    );

    await sched.accept(tok(0, "Hello"));
    await sched.accept(tok(1, "."));
    await sched.waitIdle();

    expect(metricsLog).toHaveLength(1);
    const m = metricsLog[0];
    expect(m.chunks).toHaveLength(2);
    // Float32 => 4 bytes / sample.
    expect(m.chunks[0]).toEqual({ chunkBytes: 240 * 4, chunkDurationMs: 10 });
    expect(m.chunks[1]).toEqual({ chunkBytes: 480 * 4, chunkDurationMs: 20 });
    expect(m.totalBytes).toBe((240 + 480) * 4);
    expect(m.totalDurationMs).toBe(30);
    expect(m.cancelled).toBe(false);
  });

  it("reports cancelled=false summary when synthesis completes", async () => {
    const backend = new ScriptedStreamingBackend([new Float32Array(120)]);
    const sink = new InMemoryAudioSink();
    const metricsLog: TtsPhraseChunkMetrics[] = [];
    const sched = new VoiceScheduler(
      {
        chunkerConfig: { maxTokensPerPhrase: 10 },
        preset: makePreset(),
        ringBufferCapacity: 4096,
        sampleRate: 24000,
      },
      { backend, sink },
      { onChunkMetrics: (m) => metricsLog.push(m) },
    );
    await sched.accept(tok(0, "Hi"));
    await sched.accept(tok(1, "."));
    await sched.waitIdle();
    expect(metricsLog).toHaveLength(1);
    expect(metricsLog[0].cancelled).toBe(false);
    expect(metricsLog[0].chunks).toHaveLength(1);
  });

  it("does not invoke onChunkMetrics when the listener is absent", async () => {
    const backend = new ScriptedStreamingBackend([new Float32Array(120)]);
    const sink = new InMemoryAudioSink();
    // No listener — should not throw or do extra work; the scheduler still
    // commits audio normally.
    const sched = new VoiceScheduler(
      {
        chunkerConfig: { maxTokensPerPhrase: 10 },
        preset: makePreset(),
        ringBufferCapacity: 4096,
        sampleRate: 24000,
      },
      { backend, sink },
    );
    await sched.accept(tok(0, "Hi"));
    await sched.accept(tok(1, "."));
    await sched.waitIdle();
    expect(sink.totalWritten()).toBeGreaterThan(0);
  });
});
