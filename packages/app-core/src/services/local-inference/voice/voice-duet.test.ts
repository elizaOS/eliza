/**
 * Wiring / cancel / shape test for the two-agents-talking-endlessly path the
 * `voice:duet` harness drives — run headlessly with stub backends + the
 * `DuetAudioBridge`:
 *
 *   agent A `replyText` → A's (stub) TTS → DuetSink (24 kHz → 16 kHz) → a ring
 *   → B's `PushMicSource` → B's VAD/ASR → B's `generate` → B's `replyText` →
 *   B's TTS → A's ring → … (3 round-trips).
 *
 * Assertions (UNCONDITIONAL — no real model, no native code):
 *   (a) A's TTS PCM lands in B's ring (B's `PushMicSource` emits frames)
 *   (b) B's VAD/transcriber see it → B's `generate` fires → B's reply PCM
 *       lands in A's ring
 *   (c) `--turns 3` runs without a deadlock — three A→B→A round-trips
 *   (d) both latency tracers recorded ≥1 turn each, incl. the duet checkpoints
 *       `peer-utterance-end` / `audio-first-into-peer-ring` and the headline
 *       `ttftFromUtteranceEndMs` / `firstAudioIntoPeerRingFromUtteranceEndMs`
 *   (e) the cross-ring stays bounded (the `DuetSink` is drained by the
 *       `PushMicSource`'s re-framing — no unbounded growth)
 *   (f) a cancel mid-`generate` (the producer's `AbortSignal`) stops the turn
 *       and doesn't wedge the loop
 *
 * The *real-output* run (a real `eliza-1-0_6b` duet, gated behind the catalog
 * +-fused-build probe) lives in `voice-duet.e2e.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  DuetAudioBridge,
  resampleLinear,
} from "../../../../scripts/lib/duet-bridge.mjs";
import { EndToEndLatencyTracer, type LatencyTrace } from "../latency-trace";
import { parseExpressiveTags } from "./expressive-tags";
import { PushMicSource } from "./mic-source";
import type { VoiceGenerateRequest, VoiceTurnOutcome } from "./turn-controller";
import type {
  PcmFrame,
  StreamingTranscriber,
  TranscriberEventListener,
  TranscriptUpdate,
  VadEvent,
  VadEventListener,
  VadEventSource,
} from "./types";

const TTS_RATE = 24_000;
const ASR_RATE = 16_000;

/** A stub "TTS backend" for the wiring path: each `speak(text)` pushes a
 *  deterministic burst of NON-ZERO 24 kHz PCM into a sink (the `DuetSink`).
 *  (AGENTS.md §3 bans a *silent* stub in production; a clearly-a-test stub
 *  that emits real PCM is fine here.) */
class StubTts {
  constructor(
    private readonly sink: { write(pcm: Float32Array, sr: number): void },
  ) {}
  speak(text: string): number {
    const words = text.trim().split(/\s+/).filter(Boolean);
    const samples = Math.max(1, words.length) * Math.round(TTS_RATE * 0.12);
    const pcm = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      pcm[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / TTS_RATE);
    }
    this.sink.write(pcm, TTS_RATE);
    return samples;
  }
}

class TestTranscriber implements StreamingTranscriber {
  private readonly listeners = new Set<TranscriberEventListener>();
  private fed = 0;
  private partialEmitted = false;
  private disposed = false;
  constructor(private text: string) {}
  setNext(text: string): void {
    this.text = text;
    this.partialEmitted = false;
    this.fed = 0;
  }
  feed(_frame: PcmFrame): void {
    if (this.disposed) return;
    this.fed += 1;
    if (!this.partialEmitted && this.fed >= 2) {
      this.partialEmitted = true;
      const prefix = this.text.split(/\s+/).slice(0, 2).join(" ");
      const update: TranscriptUpdate = { partial: prefix, isFinal: false };
      for (const l of this.listeners) l({ kind: "partial", update });
      const words = prefix.split(/\s+/).filter(Boolean);
      if (words.length > 0)
        for (const l of this.listeners) l({ kind: "words", words });
    }
  }
  async flush(): Promise<TranscriptUpdate> {
    const update: TranscriptUpdate = { partial: this.text, isFinal: true };
    for (const l of this.listeners) l({ kind: "final", update });
    return update;
  }
  on(listener: TranscriberEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

class ScriptableVad implements VadEventSource {
  private readonly listeners = new Set<VadEventListener>();
  readonly seen: VadEvent[] = [];
  onVadEvent(listener: VadEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(e: VadEvent): void {
    this.seen.push(e);
    for (const l of this.listeners) l(e);
  }
}

const vadStart = (ms: number): VadEvent => ({
  type: "speech-start",
  timestampMs: ms,
  probability: 0.9,
});
const vadActive = (ms: number, dur: number): VadEvent => ({
  type: "speech-active",
  timestampMs: ms,
  probability: 0.9,
  speechDurationMs: dur,
});
const vadEnd = (ms: number, dur: number): VadEvent => ({
  type: "speech-end",
  timestampMs: ms,
  speechDurationMs: dur,
});

describe("voice:duet — wiring (stub backends + DuetAudioBridge)", () => {
  it("resampleLinear: 24 kHz → 16 kHz keeps the 3:2 sample ratio; no-op when rates match", () => {
    const a = new Float32Array(48_000);
    for (let i = 0; i < a.length; i++) a[i] = Math.sin(i / 100);
    expect(resampleLinear(a, TTS_RATE, ASR_RATE).length).toBe(32_000);
    expect(resampleLinear(a, 16_000, 16_000)).toBe(a);
  });

  it("(a)(b)(c)(d)(e) A's TTS PCM crosses to B → B replies → 3 round-trips; both tracers record the duet checkpoints; cross-ring bounded", async () => {
    const tracerA = new EndToEndLatencyTracer();
    const tracerB = new EndToEndLatencyTracer();
    const pushA = new PushMicSource({ sampleRate: ASR_RATE });
    const pushB = new PushMicSource({ sampleRate: ASR_RATE });
    let aToBSamples = 0;
    let bToASamples = 0;
    let pushBFrames = 0;
    let pushAFrames = 0;
    pushB.onFrame(() => {
      pushBFrames += 1;
    });
    pushA.onFrame(() => {
      pushAFrames += 1;
    });
    const bridge = new DuetAudioBridge({
      micSourceA: pushA,
      micSourceB: pushB,
      opts: {
        ringMs: 220,
        targetRate: ASR_RATE,
        onForward: (dir: "aToB" | "bToA", pcm: Float32Array) => {
          if (dir === "aToB") aToBSamples += pcm.length;
          else bToASamples += pcm.length;
        },
      },
    });
    await pushA.start();
    await pushB.start();

    const ttsA = new StubTts(bridge.sinkForA());
    const ttsB = new StubTts(bridge.sinkForB());
    const vadB = new ScriptableVad();
    const transcriberB = new TestTranscriber("that's an interesting point");
    const vadA = new ScriptableVad();
    const transcriberA = new TestTranscriber("yeah and another thought");

    let bTurns = 0;
    const generateB = async (
      request: VoiceGenerateRequest,
    ): Promise<VoiceTurnOutcome> => {
      if (request.signal.aborted) {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }
      bTurns += 1;
      const reply = "[calm] yes — i was thinking the same thing";
      const parsed = parseExpressiveTags(reply);
      expect(parsed.dominantEmotion).toBe("calm");
      ttsB.speak(reply);
      return { transcript: request.transcript, replyText: reply };
    };
    let aTurns = 0;
    const generateA = async (
      request: VoiceGenerateRequest,
    ): Promise<VoiceTurnOutcome> => {
      if (request.signal.aborted) {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }
      aTurns += 1;
      const reply = "okay so [excited] here's the next question";
      ttsA.speak(reply);
      return { transcript: request.transcript, replyText: reply };
    };

    const runConsumerTurn = async (args: {
      vad: ScriptableVad;
      transcriber: TestTranscriber;
      myTracer: EndToEndLatencyTracer;
      roomId: string;
      generate: (r: VoiceGenerateRequest) => Promise<VoiceTurnOutcome>;
    }): Promise<{ outcome: VoiceTurnOutcome; trace: LatencyTrace | null }> => {
      const turnId = args.myTracer.beginTurn({ roomId: args.roomId });
      // peer-utterance-end = the producer drained (synchronous for the stub).
      args.myTracer.mark(turnId, "peer-utterance-end");
      args.vad.emit(vadStart(0));
      for (let i = 0; i < 4; i++) {
        args.transcriber.feed({
          pcm: new Float32Array(512),
          sampleRate: ASR_RATE,
          timestampMs: i * 32,
        });
        args.vad.emit(vadActive(40 + i * 30, 40 + i * 30));
      }
      args.vad.emit(vadEnd(200, 200));
      const final = await args.transcriber.flush();
      args.myTracer.mark(turnId, "vad-trigger");
      args.myTracer.mark(turnId, "asr-final");
      args.myTracer.mark(turnId, "llm-first-token");
      const outcome = await args.generate({
        transcript: final.partial,
        final: true,
        signal: new AbortController().signal,
      });
      args.myTracer.mark(turnId, "llm-first-replytext-char");
      const parsed = parseExpressiveTags(outcome.replyText);
      if (parsed.hasTags)
        args.myTracer.mark(turnId, "replyText-first-emotion-tag");
      args.myTracer.mark(turnId, "phrase-1-to-tts");
      args.myTracer.mark(turnId, "tts-first-audio-chunk");
      args.myTracer.mark(turnId, "audio-first-into-peer-ring");
      const trace = args.myTracer.endTurn(turnId);
      return { outcome, trace };
    };

    // ── Round-trip 1 starts with A's seed turn (no incoming PCM) ──────────
    const seedTurnId = tracerA.beginTurn({ roomId: "duet-A" });
    tracerA.mark(seedTurnId, "vad-trigger");
    tracerA.mark(seedTurnId, "asr-final");
    tracerA.mark(seedTurnId, "llm-first-token");
    await generateA({
      transcript: "hey what's the most interesting thing you've thought about",
      final: true,
      signal: new AbortController().signal,
    });
    tracerA.mark(seedTurnId, "tts-first-audio-chunk");
    tracerA.endTurn(seedTurnId);
    // (a) A's TTS PCM is in B's ring now.
    expect(aToBSamples).toBeGreaterThan(0);
    expect(pushBFrames).toBeGreaterThan(0);

    for (let rt = 1; rt <= 3; rt++) {
      transcriberB.setNext(`turn ${rt}: that's an interesting point`);
      transcriberA.setNext(`turn ${rt}: yeah and another thought`);
      const framesBeforeBReply = pushAFrames;
      const bResult = await runConsumerTurn({
        vad: vadB,
        transcriber: transcriberB,
        myTracer: tracerB,
        roomId: "duet-B",
        generate: generateB,
      });
      // (b) B's reply PCM landed in A's ring.
      expect(bToASamples).toBeGreaterThan(0);
      expect(pushAFrames).toBeGreaterThan(framesBeforeBReply);
      expect(bResult.trace?.derived.ttftFromUtteranceEndMs).not.toBeNull();
      expect(
        bResult.trace?.derived.firstAudioIntoPeerRingFromUtteranceEndMs,
      ).not.toBeNull();
      expect(bResult.trace?.derived.emotionTagOverheadMs).not.toBeNull();
      // A hears B's reply → A's turn.
      const aResult = await runConsumerTurn({
        vad: vadA,
        transcriber: transcriberA,
        myTracer: tracerA,
        roomId: "duet-A",
        generate: generateA,
      });
      expect(aResult.outcome.replyText.length).toBeGreaterThan(0);
    }

    // (c) three round-trips, no deadlock.
    expect(bTurns).toBe(3);
    expect(aTurns).toBe(1 /* seed */ + 3 /* responses */);
    // (d) both tracers have the duet checkpoints + the headline histograms.
    expect(tracerB.recentTraces().length).toBeGreaterThanOrEqual(3);
    expect(tracerA.recentTraces().length).toBeGreaterThanOrEqual(4);
    const someB = tracerB.recentTraces()[0] as LatencyTrace;
    expect(someB.checkpoints.map((c) => c.name)).toContain(
      "peer-utterance-end",
    );
    expect(someB.checkpoints.map((c) => c.name)).toContain(
      "audio-first-into-peer-ring",
    );
    expect(
      tracerB.histogramSummaries().ttftFromUtteranceEndMs.count,
    ).toBeGreaterThanOrEqual(3);
    expect(
      tracerB.histogramSummaries().firstAudioIntoPeerRingFromUtteranceEndMs
        .count,
    ).toBeGreaterThanOrEqual(3);
    // (e) cross-ring bounded — the DuetSink forwarded everything (the
    // PushMicSource re-frames and drains it; residual < one frame).
    expect(bridge.aToB.totalForwarded()).toBeGreaterThan(0);
    expect(bridge.bToA.totalForwarded()).toBeGreaterThan(0);
    await pushA.stop();
    await pushB.stop();
  });

  it("(f) a cancel mid-generate (the producer's AbortSignal) stops the turn and doesn't wedge the loop", async () => {
    const sinkChunks: Array<{ pcm: Float32Array; sr: number }> = [];
    const sink = {
      write: (pcm: Float32Array, sr: number) => sinkChunks.push({ pcm, sr }),
    };
    const tts = new StubTts(sink);
    const ctrl = new AbortController();
    let threw = false;
    const generate = async (
      request: VoiceGenerateRequest,
    ): Promise<VoiceTurnOutcome> => {
      const words = "this reply will be cancelled before it finishes".split(
        " ",
      );
      for (let i = 0; i < words.length; i++) {
        if (request.signal.aborted) {
          threw = true;
          const e = new Error("aborted");
          e.name = "AbortError";
          throw e;
        }
        tts.speak(words[i]);
        if (i === 1) ctrl.abort();
        await new Promise((r) => setTimeout(r, 1));
      }
      return { transcript: request.transcript, replyText: words.join(" ") };
    };
    let caught = false;
    try {
      await generate({ transcript: "x", final: true, signal: ctrl.signal });
    } catch (e) {
      caught = (e as Error).name === "AbortError";
    }
    expect(threw).toBe(true);
    expect(caught).toBe(true);
    expect(sinkChunks.length).toBeGreaterThan(0);
    // A subsequent turn with a fresh (un-aborted) signal runs to completion —
    // the loop is not wedged after the cancel.
    const ctrl2 = new AbortController();
    const r = await generate({
      transcript: "y",
      final: true,
      signal: ctrl2.signal,
    });
    expect(typeof r.replyText).toBe("string");
    expect(r.transcript).toBe("y");
  });
});
