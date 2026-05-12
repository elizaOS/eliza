import { describe, expect, it } from "vitest";
import {
  buildVoiceLatencyDevPayload,
  EndToEndLatencyTracer,
  LATENCY_DERIVED_KEYS,
  VOICE_CHECKPOINTS,
  type VoiceCheckpoint,
} from "./latency-trace";
import type { VadEvent, VadEventListener } from "./voice/types";

/** Drive one full turn's worth of checkpoints with explicit timestamps. */
function fullTurn(
  tracer: EndToEndLatencyTracer,
  base: number,
  offsets: Partial<Record<VoiceCheckpoint, number>>,
  roomId?: string,
): string {
  const turnId = tracer.beginTurn(roomId ? { roomId } : {});
  for (const cp of VOICE_CHECKPOINTS) {
    const off = offsets[cp];
    if (off === undefined) continue;
    tracer.mark(turnId, cp, base + off);
  }
  return turnId;
}

const CANONICAL_OFFSETS: Record<VoiceCheckpoint, number> = {
  "peer-utterance-end": -120,
  "vad-trigger": 0,
  "vad-speech-start": 30,
  "prewarm-fired": 35,
  "asr-first-partial": 220,
  "asr-final": 900,
  "llm-first-token": 1000,
  "llm-first-replytext-char": 1040,
  "replyText-first-emotion-tag": 1050,
  "phrase-1-to-tts": 1090,
  "tts-first-audio-chunk": 1200,
  "audio-first-played": 1230,
  "audio-first-into-peer-ring": 1235,
};

describe("EndToEndLatencyTracer", () => {
  it("records checkpoints and derives metrics for a complete turn", () => {
    const tracer = new EndToEndLatencyTracer();
    const turnId = fullTurn(tracer, 1_000_000, CANONICAL_OFFSETS, "roomA");
    const trace = tracer.endTurn(turnId);
    expect(trace).not.toBeNull();
    if (!trace) return;
    expect(trace.complete).toBe(true);
    // CANONICAL_OFFSETS records every checkpoint including the duet-only ones,
    // so nothing is missing.
    expect(trace.missing).toHaveLength(0);
    expect(trace.roomId).toBe("roomA");
    expect(trace.checkpoints).toHaveLength(VOICE_CHECKPOINTS.length);
    // t0 == the earliest checkpoint recorded — here `peer-utterance-end`
    // (offset -120), the duet headline t0; checkpoints sorted by atEpochMs.
    expect(trace.t0EpochMs).toBe(1_000_000 - 120);
    expect(trace.checkpoints[0]?.name).toBe("peer-utterance-end");
    expect(trace.checkpoints[0]?.tMs).toBe(0);
    // Derived spans (absolute deltas — independent of t0).
    expect(trace.derived.ttftMs).toBe(1000); // vad-trigger → llm-first-token
    expect(trace.derived.ttfaMs).toBe(1200); // vad-trigger → tts-first-audio-chunk
    expect(trace.derived.ttapMs).toBe(1230); // vad-trigger → audio-first-played
    expect(trace.derived.asrFinalLatencyMs).toBe(870); // vad-speech-start(30) → asr-final(900)
    expect(trace.derived.prewarmLatencyMs).toBe(35);
    expect(trace.derived.audioSinkLatencyMs).toBe(30); // tts-first-chunk(1200) → played(1230)
    // Duet (cross-agent) spans — peer-utterance-end(-120) is the headline t0.
    expect(trace.derived.ttftFromUtteranceEndMs).toBe(1120); // -120 → 1000
    expect(trace.derived.firstAudioIntoPeerRingFromUtteranceEndMs).toBe(1355); // -120 → 1235
    expect(trace.derived.emotionTagOverheadMs).toBe(50); // llm-first-token(1000) → tag(1050)
    expect(trace.anomalies).toHaveLength(0);
  });

  it("leaves derived metrics null when an endpoint checkpoint is missing", () => {
    const tracer = new EndToEndLatencyTracer();
    // No `audio-first-played`, no `tts-first-audio-chunk`.
    const offsets = { ...CANONICAL_OFFSETS };
    delete (offsets as Partial<Record<VoiceCheckpoint, number>>)[
      "tts-first-audio-chunk"
    ];
    delete (offsets as Partial<Record<VoiceCheckpoint, number>>)[
      "audio-first-played"
    ];
    const turnId = fullTurn(tracer, 2_000_000, offsets);
    const trace = tracer.endTurn(turnId);
    if (!trace) throw new Error("expected trace");
    expect(trace.complete).toBe(false);
    expect(trace.missing).toEqual(
      expect.arrayContaining(["tts-first-audio-chunk", "audio-first-played"]),
    );
    expect(trace.derived.ttftMs).toBe(1000); // still computable
    expect(trace.derived.ttfaMs).toBeNull(); // depends on tts-first-audio-chunk
    expect(trace.derived.ttapMs).toBeNull(); // depends on audio-first-played
    expect(trace.derived.audioSinkLatencyMs).toBeNull();
  });

  it("flags a duplicate mark and keeps the first timestamp", () => {
    const tracer = new EndToEndLatencyTracer();
    const turnId = tracer.beginTurn({});
    tracer.mark(turnId, "vad-trigger", 100);
    tracer.mark(turnId, "vad-trigger", 999); // duplicate
    tracer.mark(turnId, "llm-first-token", 600);
    const trace = tracer.endTurn(turnId);
    if (!trace) throw new Error("expected trace");
    expect(trace.anomalies.some((a) => a.includes("duplicate"))).toBe(true);
    expect(trace.derived.ttftMs).toBe(500); // 100 → 600, not 999 → 600
  });

  it("flags an out-of-order checkpoint without reordering", () => {
    const tracer = new EndToEndLatencyTracer();
    const turnId = tracer.beginTurn({});
    tracer.mark(turnId, "vad-trigger", 100);
    tracer.mark(turnId, "llm-first-token", 500);
    // asr-final ordered before llm-first-token but timestamped after it.
    tracer.mark(turnId, "asr-final", 700);
    const trace = tracer.endTurn(turnId);
    if (!trace) throw new Error("expected trace");
    expect(trace.anomalies.some((a) => a.includes("clock skew"))).toBe(true);
    expect(trace.derived.llmFirstTokenAfterAsrMs).toBe(-200); // 700 → 500 recorded as-is
  });

  it("ignores marks for unknown / closed turns", () => {
    const tracer = new EndToEndLatencyTracer();
    const turnId = tracer.beginTurn({});
    tracer.mark(turnId, "vad-trigger", 1);
    tracer.endTurn(turnId);
    // Late mark — must not throw, must not resurrect the turn.
    tracer.mark(turnId, "llm-first-token", 5);
    tracer.mark("does-not-exist", "vad-trigger", 5);
    expect(tracer.recentTraces()).toHaveLength(1);
  });

  it("evicts the oldest trace when the ring is full", () => {
    const tracer = new EndToEndLatencyTracer({ ringCapacity: 3 });
    for (let i = 0; i < 5; i += 1) {
      const turnId = tracer.beginTurn({ roomId: `room-${i}` });
      tracer.mark(turnId, "vad-trigger", i * 1000);
      tracer.mark(turnId, "llm-first-token", i * 1000 + 100);
      tracer.endTurn(turnId);
    }
    const traces = tracer.recentTraces();
    expect(traces).toHaveLength(3);
    expect(traces.map((t) => t.roomId)).toEqual(["room-2", "room-3", "room-4"]);
  });

  it("evicts the oldest *open* turn past maxOpenTurns", () => {
    const tracer = new EndToEndLatencyTracer({ maxOpenTurns: 2 });
    const a = tracer.beginTurn({ roomId: "a" });
    tracer.mark(a, "vad-trigger", 10);
    tracer.beginTurn({ roomId: "b" });
    tracer.beginTurn({ roomId: "c" }); // forces eviction of `a`
    expect(tracer.openTurnCount).toBe(2);
    // `a` was emitted with whatever it had.
    const traces = tracer.recentTraces();
    expect(traces.some((t) => t.roomId === "a")).toBe(true);
    // A mark on the evicted turn is now ignored.
    tracer.mark(a, "llm-first-token", 50);
    expect(
      tracer.recentTraces().find((t) => t.roomId === "a")?.missing,
    ).toContain("llm-first-token");
  });

  it("builds histograms with nearest-rank percentiles", () => {
    const tracer = new EndToEndLatencyTracer();
    // Five turns with ttftMs of 100, 200, 300, 400, 500.
    for (const v of [100, 200, 300, 400, 500]) {
      const turnId = tracer.beginTurn({});
      tracer.mark(turnId, "vad-trigger", 0);
      tracer.mark(turnId, "llm-first-token", v);
      tracer.endTurn(turnId);
    }
    const h = tracer.histogramSummaries();
    expect(h.ttftMs.count).toBe(5);
    expect(h.ttftMs.min).toBe(100);
    expect(h.ttftMs.max).toBe(500);
    expect(h.ttftMs.p50).toBe(300);
    expect(h.ttftMs.p90).toBe(500);
    expect(h.ttftMs.p99).toBe(500);
    expect(h.ttftMs.mean).toBe(300);
    // A metric with no samples is all-null, not zero.
    expect(h.ttfaMs.count).toBe(0);
    expect(h.ttfaMs.p50).toBeNull();
  });

  it("only feeds non-null derived metrics into the histograms", () => {
    const tracer = new EndToEndLatencyTracer();
    const turnId = tracer.beginTurn({});
    tracer.mark(turnId, "vad-trigger", 0);
    // No llm-first-token → ttftMs is null and must not become a 0 sample.
    tracer.mark(turnId, "asr-first-partial", 150);
    tracer.endTurn(turnId);
    const h = tracer.histogramSummaries();
    expect(h.ttftMs.count).toBe(0);
    expect(h.asrFirstPartialMs.count).toBe(1);
    expect(h.asrFirstPartialMs.p50).toBe(150);
  });

  it("bridges a VadEventSource onto vad-trigger / vad-speech-start", () => {
    const listeners = new Set<VadEventListener>();
    const source = {
      onVadEvent(l: VadEventListener) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    const emit = (e: VadEvent) => {
      for (const l of listeners) l(e);
    };
    const tracer = new EndToEndLatencyTracer();
    let openedTurnId: string | null = null;
    const unsub = tracer.bindVadDetector(source, {
      roomId: "roomVad",
      onTurnOpen: (id) => {
        openedTurnId = id;
      },
    });
    emit({ type: "speech-start", timestampMs: 4_242, probability: 0.9 });
    expect(openedTurnId).not.toBeNull();
    if (!openedTurnId) return;
    // The bridge recorded vad-trigger + vad-speech-start at the event ts.
    const peek = tracer.peekTurn(openedTurnId);
    expect(peek?.checkpoints.map((c) => c.name)).toEqual([
      "vad-trigger",
      "vad-speech-start",
    ]);
    expect(peek?.t0EpochMs).toBe(4_242);
    // speech-active / speech-end do not open new turns.
    emit({
      type: "speech-active",
      timestampMs: 4_500,
      probability: 0.95,
      speechDurationMs: 258,
    });
    expect(tracer.openTurnCount).toBe(1);
    unsub();
    emit({ type: "speech-start", timestampMs: 9_000, probability: 0.8 });
    // After unsubscribe, no new turn.
    expect(tracer.openTurnCount).toBe(1);
  });

  it("buildVoiceLatencyDevPayload exposes traces + histograms + metadata", () => {
    const tracer = new EndToEndLatencyTracer();
    const turnId = fullTurn(tracer, 5_000_000, CANONICAL_OFFSETS, "roomP");
    tracer.endTurn(turnId);
    const payload = buildVoiceLatencyDevPayload(tracer, 10);
    expect(payload.checkpoints).toEqual(VOICE_CHECKPOINTS);
    expect(payload.derivedKeys).toEqual(LATENCY_DERIVED_KEYS);
    expect(payload.openTurnCount).toBe(0);
    expect(payload.traces).toHaveLength(1);
    expect(payload.traces[0]?.roomId).toBe("roomP");
    expect(payload.histograms.ttftMs.count).toBe(1);
    expect(typeof payload.generatedAtEpochMs).toBe("number");
  });

  it("reset() clears traces, histograms, and open turns", () => {
    const tracer = new EndToEndLatencyTracer();
    const t = fullTurn(tracer, 1, CANONICAL_OFFSETS);
    tracer.endTurn(t);
    tracer.beginTurn({ roomId: "still-open" });
    tracer.reset();
    expect(tracer.recentTraces()).toHaveLength(0);
    expect(tracer.openTurnCount).toBe(0);
    expect(tracer.histogramSummaries().ttftMs.count).toBe(0);
  });
});
