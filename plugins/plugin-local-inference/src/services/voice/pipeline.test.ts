import { describe, expect, it } from "vitest";
import { PhraseCache } from "./phrase-cache";
import {
  type DraftProposer,
  type TargetVerifier,
  VoicePipeline,
} from "./pipeline";
import { InMemoryAudioSink } from "./ring-buffer";
import { VoiceScheduler } from "./scheduler";
import type {
  AudioChunk,
  OmniVoiceBackend,
  Phrase,
  SpeakerPreset,
  StreamingTranscriber,
  TextToken,
  TranscriptionAudio,
  TranscriptUpdate,
} from "./types";

function makePreset(): SpeakerPreset {
  const embedding = new Float32Array([0.1, 0.2, 0.3]);
  return {
    voiceId: "default",
    embedding,
    bytes: new Uint8Array(embedding.buffer.slice(0)),
  };
}

class StubBackend implements OmniVoiceBackend {
  calls = 0;
  delay = 0;
  async synthesize(args: {
    phrase: Phrase;
    preset: SpeakerPreset;
    cancelSignal: { cancelled: boolean };
    onKernelTick?: () => void;
  }): Promise<AudioChunk> {
    this.calls++;
    if (this.delay > 0) await new Promise((r) => setTimeout(r, this.delay));
    args.onKernelTick?.();
    if (args.cancelSignal.cancelled) {
      return {
        phraseId: args.phrase.id,
        fromIndex: args.phrase.fromIndex,
        toIndex: args.phrase.toIndex,
        pcm: new Float32Array(0),
        sampleRate: 24000,
      };
    }
    const tokenCount = args.phrase.toIndex - args.phrase.fromIndex + 1;
    return {
      phraseId: args.phrase.id,
      fromIndex: args.phrase.fromIndex,
      toIndex: args.phrase.toIndex,
      pcm: new Float32Array(Math.max(1, tokenCount * 8)).fill(0.1),
      sampleRate: 24000,
    };
  }
}

function makeScheduler(backend: OmniVoiceBackend, sink: InMemoryAudioSink) {
  return new VoiceScheduler(
    {
      chunkerConfig: { maxTokensPerPhrase: 4 },
      preset: makePreset(),
      ringBufferCapacity: 4096,
      sampleRate: 24000,
    },
    { backend, sink },
  );
}

const audio: TranscriptionAudio = {
  pcm: new Float32Array(2400),
  sampleRate: 24000,
};

/**
 * `StreamingTranscriber` stub: `flush()` returns a transcript whose
 * whitespace-aware split (`splitTranscriptToTokens`) reproduces `tokens`.
 * `delayMs` delays the final decode so a test can barge in mid-`flush()`.
 */
class StubTranscriber implements StreamingTranscriber {
  finishedAt = -1;
  fed = false;
  disposed = false;
  constructor(
    private readonly tokens: TextToken[],
    private readonly delayMs = 0,
  ) {}
  feed(): void {
    this.fed = true;
  }
  async flush(): Promise<TranscriptUpdate> {
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
    this.finishedAt = Date.now();
    return { partial: this.tokens.map((t) => t.text).join(""), isFinal: true };
  }
  on(): () => void {
    return () => {};
  }
  dispose(): void {
    this.disposed = true;
  }
}

describe("VoicePipeline overlap", () => {
  it("the DFlash drafter starts the instant ASR emits its last token", async () => {
    const events: string[] = [];
    const asrTokens: TextToken[] = [
      { index: 0, text: "hi" },
      { index: 1, text: " there" },
    ];
    const transcriber = new StubTranscriber(asrTokens, 2);
    const drafter: DraftProposer = {
      async propose() {
        events.push("draft");
        return [];
      },
    };
    const verifier: TargetVerifier = {
      async verify() {
        events.push("verify");
        return { accepted: [{ index: 0, text: " ok." }], done: true };
      },
    };
    const sink = new InMemoryAudioSink();
    const backend = new StubBackend();
    const scheduler = makeScheduler(backend, sink);
    const pipeline = new VoicePipeline(
      { scheduler, transcriber, drafter, verifier },
      { maxDraftTokens: 4 },
      {
        onAsrComplete: () => events.push("asr-done"),
      },
    );

    const reason = await pipeline.run(audio);
    expect(reason).toBe("done");
    // ASR finishes first, then the drafter is the first generation node
    // to run — and it runs concurrently with the verifier (both kicked
    // before either is awaited).
    expect(events[0]).toBe("asr-done");
    expect(events[1]).toBe("draft");
    expect(events).toContain("verify");
  });

  it("overlaps the drafter and verifier passes (next draft kicked before verify resolves)", async () => {
    const order: string[] = [];
    const transcriber = new StubTranscriber([{ index: 0, text: "go" }]);
    let draftCalls = 0;
    const drafter: DraftProposer = {
      async propose() {
        const id = draftCalls++;
        order.push(`draft${id}:start`);
        await new Promise((r) => setTimeout(r, 10));
        order.push(`draft${id}:end`);
        return id === 0 ? [{ index: 0, text: " a" }] : [];
      },
    };
    let verifyCalls = 0;
    const verifier: TargetVerifier = {
      async verify() {
        const id = verifyCalls++;
        order.push(`verify${id}:start`);
        await new Promise((r) => setTimeout(r, 10));
        order.push(`verify${id}:end`);
        // round 0: accept the drafted token + a correction, not done.
        // round 1: empty draft, accept one terminal token, done.
        if (id === 0)
          return {
            accepted: [
              { index: 0, text: " a" },
              { index: 0, text: " cat." },
            ],
            done: false,
          };
        return { accepted: [{ index: 0, text: " end." }], done: true };
      },
    };
    const sink = new InMemoryAudioSink();
    const scheduler = makeScheduler(new StubBackend(), sink);
    const pipeline = new VoicePipeline(
      { scheduler, transcriber, drafter, verifier },
      { maxDraftTokens: 4 },
    );
    await pipeline.run(audio);
    await scheduler.waitIdle();
    // draft1 (round 0's "next draft") must START before verify0 ENDS —
    // that is the overlap.
    const d1Start = order.indexOf("draft1:start");
    const v0End = order.indexOf("verify0:end");
    expect(d1Start).toBeGreaterThanOrEqual(0);
    expect(v0End).toBeGreaterThanOrEqual(0);
    expect(d1Start).toBeLessThan(v0End);
  });

  it("rolls back not-yet-spoken TTS chunks when the verifier rejects a draft tail", async () => {
    const rollbacks: number[] = [];
    const transcriber = new StubTranscriber([{ index: 0, text: "q" }]);
    let draftCalls = 0;
    const drafter: DraftProposer = {
      async propose() {
        draftCalls++;
        if (draftCalls === 1)
          return [
            { index: 0, text: "A." },
            { index: 0, text: "B." },
            { index: 0, text: "C." },
          ];
        return [];
      },
    };
    let verifyCalls = 0;
    const verifier: TargetVerifier = {
      async verify() {
        verifyCalls++;
        if (verifyCalls === 1) {
          // accept "A." from the draft, reject "B." and "C.", correct to "X."
          return {
            accepted: [
              { index: 0, text: "A." },
              { index: 0, text: "X." },
            ],
            done: false,
          };
        }
        return { accepted: [{ index: 0, text: "Y." }], done: true };
      },
    };
    const sink = new InMemoryAudioSink();
    const backend = new StubBackend();
    backend.delay = 5;
    const scheduler = new VoiceScheduler(
      {
        chunkerConfig: { maxTokensPerPhrase: 1 }, // each token = a phrase
        preset: makePreset(),
        ringBufferCapacity: 4096,
        sampleRate: 24000,
      },
      { backend, sink },
      { onRollback: (id) => rollbacks.push(id) },
    );
    const pipeline = new VoicePipeline(
      { scheduler, transcriber, drafter, verifier },
      { maxDraftTokens: 4 },
    );
    await pipeline.run(audio);
    await scheduler.waitIdle();
    // Phrases: 0="A." 1="B." 2="C." 3="X." 4="Y.". The reject covers the
    // text positions of "B." and "C." → those phrases roll back.
    expect(rollbacks).toContain(1);
    expect(rollbacks).toContain(2);
    expect(rollbacks).not.toContain(0);
    // "A.", "X.", "Y." survive → 3 audio chunks.
    expect(sink.chunks.length).toBe(3);
  });

  it("barge-in cancels the in-flight turn (ASR + drafter/verifier loop) and drains audio", async () => {
    const transcriber = new StubTranscriber(
      [
        { index: 0, text: "long" },
        { index: 1, text: " input" },
        { index: 2, text: " here" },
      ],
      30, // slow ASR so we can barge in mid-transcription
    );
    let draftCalls = 0;
    const drafter: DraftProposer = {
      async propose() {
        draftCalls++;
        return [];
      },
    };
    const verifier: TargetVerifier = {
      async verify() {
        return { accepted: [], done: true };
      },
    };
    const sink = new InMemoryAudioSink();
    const scheduler = makeScheduler(new StubBackend(), sink);
    const pipeline = new VoicePipeline(
      { scheduler, transcriber, drafter, verifier },
      { maxDraftTokens: 4 },
    );
    const runPromise = pipeline.run(audio);
    await new Promise((r) => setTimeout(r, 10)); // mid-ASR
    pipeline.cancel();
    const reason = await runPromise;
    expect(reason).toBe("cancelled");
    // Drafter never ran — we cancelled before ASR completed.
    expect(draftCalls).toBe(0);
    // Barge-in drained the ring buffer / nothing got synthesized.
    expect(sink.totalWritten()).toBe(0);
    expect(scheduler.bargeIn.cancelSignal().cancelled).toBe(true);
  });

  it("uses the phrase cache for first-byte latency (cached utterance skips TTS forward pass)", async () => {
    // The scheduler consults the phrase cache before dispatching TTS;
    // a cached phrase commits audio without a backend.synthesize call.
    const transcriber = new StubTranscriber([{ index: 0, text: "q" }]);
    const drafter: DraftProposer = {
      async propose() {
        return [];
      },
    };
    const verifier: TargetVerifier = {
      async verify() {
        return { accepted: [{ index: 0, text: "Sure." }], done: true };
      },
    };
    const sink = new InMemoryAudioSink();
    const backend = new StubBackend();
    const phraseCache = new PhraseCache();
    phraseCache.put({
      text: "Sure.",
      pcm: new Float32Array(64).fill(0.2),
      sampleRate: 24000,
    });
    const scheduler = new VoiceScheduler(
      {
        chunkerConfig: { maxTokensPerPhrase: 1 },
        preset: makePreset(),
        ringBufferCapacity: 4096,
        sampleRate: 24000,
      },
      { backend, sink, phraseCache },
    );
    const pipeline = new VoicePipeline(
      { scheduler, transcriber, drafter, verifier },
      { maxDraftTokens: 4 },
    );
    await pipeline.run(audio);
    await scheduler.waitIdle();
    expect(backend.calls).toBe(0); // served entirely from the phrase cache
    expect(sink.chunks.length).toBe(1);
  });
});
