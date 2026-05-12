/**
 * End-to-end voice-loop latency tracing.
 *
 * One `LatencyTrace` per voice turn — a span recorder with named
 * checkpoints from "user makes a sound" to "agent's first audio plays".
 * The checkpoint set is fixed (`VOICE_CHECKPOINTS`) and ordered; each
 * checkpoint is recorded at most once per turn. Missing checkpoints are
 * surfaced as `incomplete` — never synthesized — and derived metrics that
 * depend on a missing checkpoint stay `null` (AGENTS.md §3 / §7: a missing
 * measurement is recorded as missing, not faked).
 *
 * Ownership / lifecycle:
 *   - The turn controller (`voice/turn-controller.ts`, W9) is the natural
 *     owner of the per-turn tracer: it calls `tracer.beginTurn({...})` when
 *     a turn opens and `tracer.endTurn(turnId)` when it finalizes/aborts.
 *     Until that lands, callers can use the module-level
 *     `voiceLatencyTracer` singleton + the `markVoiceLatency()` helper —
 *     the singleton lazily opens a turn keyed by `roomId` on first mark.
 *   - Components that produce a checkpoint either (a) hold a `tracer` and
 *     call `tracer.mark(turnId, checkpoint)`, or (b) call the context-free
 *     `markVoiceLatency(roomId, checkpoint)` helper. `bindVadDetector()`
 *     bridges a `VadEventSource` onto the tracer without touching `vad.ts`.
 *
 * Hook points (where each checkpoint is meant to be recorded):
 *   - `peer-utterance-end`       — (DUET ONLY) the producing agent's
 *                                   scheduler drained its last PCM chunk into
 *                                   the cross ring — the headline `t0` for a
 *                                   two-agents-talking run (`voice-duet.mjs`).
 *                                   Not recorded in the single-agent path.
 *   - `vad-trigger`              — `VadDetector` energy-rise edge / the
 *                                   turn controller's wake instant.
 *   - `vad-speech-start`         — `VadDetector` Silero speech-start.
 *   - `prewarm-fired`            — the turn controller (W9) when it calls
 *                                   W6's `prewarmConversation`.
 *   - `asr-first-partial`        — `StreamingTranscriber` first `partial`.
 *   - `asr-final`                — `StreamingTranscriber` `final`.
 *   - `llm-first-token`          — the engine generate path's first
 *                                   `onTextChunk` (W4).
 *   - `llm-first-replytext-char` — `StructuredFieldStreamExtractor`'s
 *                                   `onFieldStart("replyText")` (W3).
 *   - `replyText-first-emotion-tag` — the field extractor / `parseExpressiveTags`
 *                                   on the first inline expressive tag (`[happy]`
 *                                   …) in `replyText` — emotion-markup overhead,
 *                                   measured the way `envelopeToReplyTextMs`
 *                                   measures envelope overhead.
 *   - `phrase-1-to-tts`          — the scheduler/chunker (W9) on the first
 *                                   phrase handed to the TTS backend.
 *   - `tts-first-audio-chunk`    — the TTS backend's first PCM chunk (W7).
 *   - `audio-first-played`       — the audio sink on the first written
 *                                   sample (W9/W13) — single-agent path.
 *   - `audio-first-into-peer-ring` — (DUET ONLY) the responding agent's first
 *                                   TTS PCM chunk landed in the peer's ring
 *                                   (the duet replacement for
 *                                   `audio-first-played` — no speakers).
 *
 * Logger only, `[LatencyTracer]` prefix (AGENTS.md §9).
 */

import { logger } from "@elizaos/core";
import type { VadEvent, VadEventSource } from "./voice/types";

// ---------------------------------------------------------------------------
// Checkpoint set (ordered)
// ---------------------------------------------------------------------------

/**
 * The fixed, ordered set of latency checkpoints. The recorder enforces the
 * order is non-decreasing in wall-clock terms only loosely — a checkpoint
 * arriving "out of order" (a later checkpoint with an earlier timestamp) is
 * recorded as-is and flagged; we never reorder or clamp.
 */
export const VOICE_CHECKPOINTS = [
  "peer-utterance-end",
  "vad-trigger",
  "vad-speech-start",
  "prewarm-fired",
  "asr-first-partial",
  "asr-final",
  "llm-first-token",
  "llm-first-replytext-char",
  "replyText-first-emotion-tag",
  "phrase-1-to-tts",
  "tts-first-audio-chunk",
  "audio-first-played",
  "audio-first-into-peer-ring",
] as const;

export type VoiceCheckpoint = (typeof VOICE_CHECKPOINTS)[number];

const CHECKPOINT_ORDER: Readonly<Record<VoiceCheckpoint, number>> =
  Object.fromEntries(VOICE_CHECKPOINTS.map((c, i) => [c, i])) as Record<
    VoiceCheckpoint,
    number
  >;

/**
 * Checkpoints that only appear in specific run shapes — `peer-utterance-end`
 * and `audio-first-into-peer-ring` are recorded only by the two-agents duet
 * harness; `replyText-first-emotion-tag` only when the model emits an inline
 * expressive tag. Their absence does NOT make a trace `incomplete` (a
 * single-agent voice turn is "complete" without them); they are still listed
 * in `missing` so the duet harness can see which ones it didn't get.
 */
const OPTIONAL_CHECKPOINTS: ReadonlySet<VoiceCheckpoint> = new Set([
  "peer-utterance-end",
  "replyText-first-emotion-tag",
  "audio-first-into-peer-ring",
]);

/** The single-agent "core" checkpoint set — every checkpoint that is NOT
 *  optional. A trace is `complete` iff every core checkpoint was recorded. */
export const CORE_VOICE_CHECKPOINTS = VOICE_CHECKPOINTS.filter(
  (c) => !OPTIONAL_CHECKPOINTS.has(c),
);

// ---------------------------------------------------------------------------
// Derived metrics
// ---------------------------------------------------------------------------

/**
 * Derived per-turn metrics. Every field is the duration between two
 * checkpoints; `null` whenever either endpoint checkpoint is missing for
 * the turn — there is no fallback estimate.
 */
export interface LatencyDerived {
  /** vad-trigger → llm-first-token (time-to-first-token). */
  ttftMs: number | null;
  /** vad-trigger → tts-first-audio-chunk (time-to-first-audio). */
  ttfaMs: number | null;
  /** vad-trigger → audio-first-played (time-to-audio-played; the headline). */
  ttapMs: number | null;
  /** vad-speech-start → asr-final (ASR finalization latency). */
  asrFinalLatencyMs: number | null;
  /** vad-trigger → asr-first-partial (how fast the first words appear). */
  asrFirstPartialMs: number | null;
  /** vad-trigger → prewarm-fired (how fast the prewarm kicks off). */
  prewarmLatencyMs: number | null;
  /** asr-final → llm-first-token (LLM latency once the prompt is complete). */
  llmFirstTokenAfterAsrMs: number | null;
  /** llm-first-token → llm-first-replytext-char (envelope-skip overhead). */
  envelopeToReplyTextMs: number | null;
  /** llm-first-replytext-char → phrase-1-to-tts (chunker hand-off lag). */
  replyTextToPhrase1Ms: number | null;
  /** phrase-1-to-tts → tts-first-audio-chunk (TTS first-chunk latency). */
  ttsFirstChunkMs: number | null;
  /** tts-first-audio-chunk → audio-first-played (sink/playback lag). */
  audioSinkLatencyMs: number | null;
  // ── Duet (cross-agent) spans — `null` outside the duet harness. ──────────
  /**
   * peer-utterance-end → llm-first-token — **THE headline number** for the
   * two-agents-talking benchmark: how long after the peer stopped speaking
   * the responding agent emits its first token (TTFT-from-last-utterance).
   */
  ttftFromUtteranceEndMs: number | null;
  /** peer-utterance-end → llm-first-replytext-char. */
  replyTextFirstCharFromUtteranceEndMs: number | null;
  /** peer-utterance-end → tts-first-audio-chunk. */
  firstTtsPcmFromUtteranceEndMs: number | null;
  /**
   * peer-utterance-end → audio-first-into-peer-ring — the **duet round-trip**:
   * peer stops speaking → responding agent's first audio is back in the
   * peer's ear (the `duet_round_trip_ms` gate reads `.p50` of this).
   */
  firstAudioIntoPeerRingFromUtteranceEndMs: number | null;
  /** llm-first-token → replyText-first-emotion-tag (emotion-markup overhead);
   *  `null` when the model emitted no inline expressive tag. */
  emotionTagOverheadMs: number | null;
}

/** The derived-metric keys, in display order. */
export const LATENCY_DERIVED_KEYS = [
  "ttftMs",
  "ttfaMs",
  "ttapMs",
  "asrFinalLatencyMs",
  "asrFirstPartialMs",
  "prewarmLatencyMs",
  "llmFirstTokenAfterAsrMs",
  "envelopeToReplyTextMs",
  "replyTextToPhrase1Ms",
  "ttsFirstChunkMs",
  "audioSinkLatencyMs",
  "ttftFromUtteranceEndMs",
  "replyTextFirstCharFromUtteranceEndMs",
  "firstTtsPcmFromUtteranceEndMs",
  "firstAudioIntoPeerRingFromUtteranceEndMs",
  "emotionTagOverheadMs",
] as const satisfies ReadonlyArray<keyof LatencyDerived>;

export type LatencyDerivedKey = (typeof LATENCY_DERIVED_KEYS)[number];

const DERIVED_SPANS: Readonly<
  Record<LatencyDerivedKey, readonly [VoiceCheckpoint, VoiceCheckpoint]>
> = {
  ttftMs: ["vad-trigger", "llm-first-token"],
  ttfaMs: ["vad-trigger", "tts-first-audio-chunk"],
  ttapMs: ["vad-trigger", "audio-first-played"],
  asrFinalLatencyMs: ["vad-speech-start", "asr-final"],
  asrFirstPartialMs: ["vad-trigger", "asr-first-partial"],
  prewarmLatencyMs: ["vad-trigger", "prewarm-fired"],
  llmFirstTokenAfterAsrMs: ["asr-final", "llm-first-token"],
  envelopeToReplyTextMs: ["llm-first-token", "llm-first-replytext-char"],
  replyTextToPhrase1Ms: ["llm-first-replytext-char", "phrase-1-to-tts"],
  ttsFirstChunkMs: ["phrase-1-to-tts", "tts-first-audio-chunk"],
  audioSinkLatencyMs: ["tts-first-audio-chunk", "audio-first-played"],
  ttftFromUtteranceEndMs: ["peer-utterance-end", "llm-first-token"],
  replyTextFirstCharFromUtteranceEndMs: [
    "peer-utterance-end",
    "llm-first-replytext-char",
  ],
  firstTtsPcmFromUtteranceEndMs: [
    "peer-utterance-end",
    "tts-first-audio-chunk",
  ],
  firstAudioIntoPeerRingFromUtteranceEndMs: [
    "peer-utterance-end",
    "audio-first-into-peer-ring",
  ],
  emotionTagOverheadMs: ["llm-first-token", "replyText-first-emotion-tag"],
};

// ---------------------------------------------------------------------------
// Trace shape
// ---------------------------------------------------------------------------

export interface LatencyCheckpoint {
  name: VoiceCheckpoint;
  /** Wall-clock ms since the turn's `t0` (the first checkpoint recorded). */
  tMs: number;
  /** Absolute epoch ms when the checkpoint was recorded. */
  atEpochMs: number;
}

export interface LatencyTrace {
  turnId: string;
  roomId: string | null;
  /** Epoch ms of the first checkpoint recorded for this turn (the t=0 ref). */
  t0EpochMs: number;
  /** Epoch ms when `endTurn` was called, or null while still open. */
  closedAtEpochMs: number | null;
  checkpoints: LatencyCheckpoint[];
  derived: LatencyDerived;
  /** Names of checkpoints that were never recorded for this turn. */
  missing: VoiceCheckpoint[];
  /** True when every checkpoint in `VOICE_CHECKPOINTS` was recorded. */
  complete: boolean;
  /**
   * Non-empty when the recorder saw something it could not reconcile —
   * a duplicate mark, an out-of-order timestamp, an unknown checkpoint.
   * Diagnostic only; the trace is still emitted.
   */
  anomalies: string[];
}

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

export interface HistogramSummary {
  count: number;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  min: number | null;
  max: number | null;
  mean: number | null;
}

/**
 * Bounded-sample running histogram for one derived metric. Keeps the last
 * `capacity` samples (FIFO) and computes percentiles on demand. Bounded so
 * a long-running process does not grow without limit.
 */
class BoundedHistogram {
  private readonly samples: number[] = [];
  constructor(private readonly capacity: number) {}

  add(value: number): void {
    if (!Number.isFinite(value)) return;
    this.samples.push(value);
    if (this.samples.length > this.capacity) this.samples.shift();
  }

  summary(): HistogramSummary {
    const n = this.samples.length;
    if (n === 0) {
      return {
        count: 0,
        p50: null,
        p90: null,
        p99: null,
        min: null,
        max: null,
        mean: null,
      };
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    const pct = (p: number): number => {
      // Nearest-rank percentile on the sorted sample.
      const rank = Math.ceil((p / 100) * n);
      const idx = Math.min(n - 1, Math.max(0, rank - 1));
      return sorted[idx] as number;
    };
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    return {
      count: n,
      p50: pct(50),
      p90: pct(90),
      p99: pct(99),
      min: sorted[0] as number,
      max: sorted[n - 1] as number,
      mean: sum / n,
    };
  }
}

// ---------------------------------------------------------------------------
// Tracer
// ---------------------------------------------------------------------------

export interface TracerOptions {
  /** Max number of completed traces to retain in the ring. Default 64. */
  ringCapacity?: number;
  /** Max samples per derived-metric histogram. Default 256. */
  histogramCapacity?: number;
  /**
   * Max number of concurrently-open turns. A new `beginTurn` past this cap
   * evicts the oldest still-open turn (it is closed and emitted with whatever
   * checkpoints it had). Guards against a leaked turn never being closed.
   * Default 16.
   */
  maxOpenTurns?: number;
}

interface OpenTurn {
  turnId: string;
  roomId: string | null;
  t0EpochMs: number | null;
  /** name -> atEpochMs for recorded checkpoints. */
  marks: Map<VoiceCheckpoint, number>;
  anomalies: string[];
}

let TURN_COUNTER = 0;
function nextTurnId(): string {
  TURN_COUNTER += 1;
  return `vt-${Date.now().toString(36)}-${TURN_COUNTER.toString(36)}`;
}

export class EndToEndLatencyTracer {
  private readonly ring: LatencyTrace[] = [];
  private readonly open = new Map<string, OpenTurn>();
  private readonly byRoom = new Map<string, string>();
  private readonly histograms = new Map<LatencyDerivedKey, BoundedHistogram>();
  private readonly ringCapacity: number;
  private readonly histogramCapacity: number;
  private readonly maxOpenTurns: number;

  constructor(opts: TracerOptions = {}) {
    this.ringCapacity = Math.max(1, opts.ringCapacity ?? 64);
    this.histogramCapacity = Math.max(1, opts.histogramCapacity ?? 256);
    this.maxOpenTurns = Math.max(1, opts.maxOpenTurns ?? 16);
    for (const key of LATENCY_DERIVED_KEYS) {
      this.histograms.set(key, new BoundedHistogram(this.histogramCapacity));
    }
  }

  /**
   * Open a new turn. Returns the `turnId`. If `roomId` is given, subsequent
   * context-free marks for that room route to this turn until it is closed.
   */
  beginTurn(args: { turnId?: string; roomId?: string | null } = {}): string {
    const turnId = args.turnId ?? nextTurnId();
    if (this.open.has(turnId)) return turnId;
    if (this.open.size >= this.maxOpenTurns) {
      // Evict the oldest open turn — better to emit a partial trace than to
      // leak. `open` preserves insertion order.
      const oldest = this.open.keys().next().value as string | undefined;
      if (oldest) {
        logger.warn(
          `[LatencyTracer] evicting stale open turn ${oldest} (maxOpenTurns=${this.maxOpenTurns})`,
        );
        this.endTurn(oldest);
      }
    }
    const roomId = args.roomId ?? null;
    this.open.set(turnId, {
      turnId,
      roomId,
      t0EpochMs: null,
      marks: new Map(),
      anomalies: [],
    });
    if (roomId) this.byRoom.set(roomId, turnId);
    return turnId;
  }

  /** Resolve (or lazily open) a turn for a roomId. Used by the helper. */
  turnForRoom(roomId: string): string {
    const existing = this.byRoom.get(roomId);
    if (existing && this.open.has(existing)) return existing;
    return this.beginTurn({ roomId });
  }

  /**
   * Record a checkpoint on an open turn. No-op (with a warning) if the turn
   * is unknown or already closed — a late mark on a finalized turn is a
   * caller bug, not something to retroactively patch into history.
   */
  mark(turnId: string, checkpoint: VoiceCheckpoint, atEpochMs?: number): void {
    if (!VOICE_CHECKPOINTS.includes(checkpoint)) {
      logger.warn(`[LatencyTracer] unknown checkpoint "${checkpoint}" ignored`);
      return;
    }
    const turn = this.open.get(turnId);
    if (!turn) {
      logger.warn(
        `[LatencyTracer] mark("${checkpoint}") for unknown/closed turn ${turnId} ignored`,
      );
      return;
    }
    const now = atEpochMs ?? Date.now();
    if (turn.t0EpochMs === null) turn.t0EpochMs = now;
    if (turn.marks.has(checkpoint)) {
      turn.anomalies.push(
        `duplicate mark for "${checkpoint}" (kept first, ignored ${now})`,
      );
      return;
    }
    // Out-of-order detection: a checkpoint with a lower order index but a
    // later timestamp than an already-recorded later checkpoint. Recorded
    // as-is; flagged.
    const order = CHECKPOINT_ORDER[checkpoint];
    for (const [seen, at] of turn.marks) {
      if (CHECKPOINT_ORDER[seen] > order && at < now) {
        turn.anomalies.push(
          `"${checkpoint}" recorded after later checkpoint "${seen}" (clock skew?)`,
        );
        break;
      }
    }
    turn.marks.set(checkpoint, now);
  }

  /** Convenience: mark a checkpoint by roomId, opening a turn if needed. */
  markByRoom(
    roomId: string,
    checkpoint: VoiceCheckpoint,
    atEpochMs?: number,
  ): void {
    this.mark(this.turnForRoom(roomId), checkpoint, atEpochMs);
  }

  /**
   * Close an open turn: snapshot it into a `LatencyTrace`, push to the ring
   * (evicting the oldest), and fold its derived metrics into the histograms.
   * Idempotent for an unknown turnId. Returns the emitted trace (or null if
   * the turn was unknown).
   */
  endTurn(turnId: string): LatencyTrace | null {
    const turn = this.open.get(turnId);
    if (!turn) return null;
    this.open.delete(turnId);
    if (turn.roomId && this.byRoom.get(turn.roomId) === turnId) {
      this.byRoom.delete(turn.roomId);
    }
    const trace = this.snapshotTurn(turn, Date.now());
    this.ring.push(trace);
    while (this.ring.length > this.ringCapacity) this.ring.shift();
    for (const key of LATENCY_DERIVED_KEYS) {
      const v = trace.derived[key];
      if (v !== null) this.histograms.get(key)?.add(v);
    }
    return trace;
  }

  /** A read-only snapshot of an open turn (does not close it). */
  peekTurn(turnId: string): LatencyTrace | null {
    const turn = this.open.get(turnId);
    if (!turn) return null;
    return this.snapshotTurn(turn, null);
  }

  /** The most recent `n` completed traces, newest last. */
  recentTraces(n = this.ringCapacity): LatencyTrace[] {
    if (n >= this.ring.length) return [...this.ring];
    return this.ring.slice(this.ring.length - n);
  }

  /** Per-derived-metric histogram summaries over the retained sample. */
  histogramSummaries(): Record<LatencyDerivedKey, HistogramSummary> {
    const out = {} as Record<LatencyDerivedKey, HistogramSummary>;
    for (const key of LATENCY_DERIVED_KEYS) {
      out[key] = this.histograms.get(key)?.summary() ?? {
        count: 0,
        p50: null,
        p90: null,
        p99: null,
        min: null,
        max: null,
        mean: null,
      };
    }
    return out;
  }

  /** Drop all retained traces, histograms, and open turns. */
  reset(): void {
    this.ring.length = 0;
    this.open.clear();
    this.byRoom.clear();
    for (const key of LATENCY_DERIVED_KEYS) {
      this.histograms.set(key, new BoundedHistogram(this.histogramCapacity));
    }
  }

  /** Number of turns currently open (un-closed). */
  get openTurnCount(): number {
    return this.open.size;
  }

  /**
   * Bridge a VAD event source onto this tracer: subscribes to the
   * `VadEvent` stream and emits `vad-trigger` + `vad-speech-start` on the
   * Silero rising edge (the earliest reliable per-turn `t0`). Returns the
   * unsubscribe function. This is the documented seam that lets the tracer
   * hook the VAD without editing `voice/vad.ts` — the true energy-rise
   * "wake" instant is owned by the turn controller (W9), which calls
   * `mark(turnId, "vad-trigger")` directly; this bridge is the fallback for
   * plain VAD-only setups.
   */
  bindVadDetector(
    source: VadEventSource,
    args: {
      roomId?: string | null;
      onTurnOpen?: (turnId: string) => void;
    } = {},
  ): () => void {
    const handler = (event: VadEvent): void => {
      if (event.type === "speech-start") {
        const turnId = this.beginTurn({ roomId: args.roomId ?? null });
        this.mark(turnId, "vad-trigger", event.timestampMs || undefined);
        this.mark(turnId, "vad-speech-start", event.timestampMs || undefined);
        args.onTurnOpen?.(turnId);
      }
    };
    return source.onVadEvent(handler);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private snapshotTurn(
    turn: OpenTurn,
    closedAtEpochMs: number | null,
  ): LatencyTrace {
    const t0 = turn.t0EpochMs ?? closedAtEpochMs ?? Date.now();
    const checkpoints: LatencyCheckpoint[] = [];
    for (const name of VOICE_CHECKPOINTS) {
      const at = turn.marks.get(name);
      if (at === undefined) continue;
      checkpoints.push({ name, atEpochMs: at, tMs: at - t0 });
    }
    checkpoints.sort((a, b) => a.atEpochMs - b.atEpochMs);
    const missing = VOICE_CHECKPOINTS.filter((c) => !turn.marks.has(c));
    // "Complete" = every *core* (non-optional) checkpoint recorded — a
    // single-agent voice turn is complete without the duet-only / emotion-tag
    // checkpoints.
    const coreMissing = CORE_VOICE_CHECKPOINTS.some((c) => !turn.marks.has(c));
    return {
      turnId: turn.turnId,
      roomId: turn.roomId,
      t0EpochMs: t0,
      closedAtEpochMs,
      checkpoints,
      derived: this.computeDerived(turn.marks),
      missing,
      complete: !coreMissing,
      anomalies: [...turn.anomalies],
    };
  }

  private computeDerived(marks: Map<VoiceCheckpoint, number>): LatencyDerived {
    const span = (
      from: VoiceCheckpoint,
      to: VoiceCheckpoint,
    ): number | null => {
      const a = marks.get(from);
      const b = marks.get(to);
      if (a === undefined || b === undefined) return null;
      return b - a;
    };
    const out = {} as LatencyDerived;
    for (const key of LATENCY_DERIVED_KEYS) {
      const [from, to] = DERIVED_SPANS[key];
      out[key] = span(from, to);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton + context-free helper
// ---------------------------------------------------------------------------

/**
 * Process-wide tracer. The turn controller (W9) owns per-turn lifecycle
 * via `beginTurn` / `endTurn`; components that only know a `roomId` use
 * `markVoiceLatency(roomId, checkpoint)` which routes through `markByRoom`.
 * The dev endpoint (`GET /api/dev/voice-latency`) reads this singleton.
 */
export const voiceLatencyTracer = new EndToEndLatencyTracer();

/**
 * Record a checkpoint on the process-wide tracer, keyed by `roomId`. Opens
 * a turn for that room on first call. No-op-safe — instrumentation must
 * never throw into the voice loop. This is the seam every component (VAD,
 * turn controller, engine, field extractor, chunker, TTS backend, audio
 * sink) can call without threading a tracer reference.
 */
export function markVoiceLatency(
  roomId: string | null | undefined,
  checkpoint: VoiceCheckpoint,
  atEpochMs?: number,
): void {
  try {
    if (!roomId) {
      // No room context — open an anonymous turn so the mark is not lost.
      const turnId = voiceLatencyTracer.beginTurn({});
      voiceLatencyTracer.mark(turnId, checkpoint, atEpochMs);
      return;
    }
    voiceLatencyTracer.markByRoom(roomId, checkpoint, atEpochMs);
  } catch (err) {
    logger.warn(
      `[LatencyTracer] markVoiceLatency("${checkpoint}") failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Close the process-wide tracer's turn for a roomId, returning the trace. */
export function endVoiceLatencyTurn(roomId: string): LatencyTrace | null {
  try {
    const turnId = voiceLatencyTracer.turnForRoom(roomId);
    return voiceLatencyTracer.endTurn(turnId);
  } catch (err) {
    logger.warn(
      `[LatencyTracer] endVoiceLatencyTurn(${roomId}) failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// JSON payload for the dev endpoint
// ---------------------------------------------------------------------------

export interface VoiceLatencyDevPayload {
  generatedAtEpochMs: number;
  /** Checkpoint names, in canonical order — so consumers can render headers. */
  checkpoints: ReadonlyArray<VoiceCheckpoint>;
  derivedKeys: ReadonlyArray<LatencyDerivedKey>;
  openTurnCount: number;
  traces: LatencyTrace[];
  histograms: Record<LatencyDerivedKey, HistogramSummary>;
}

/** Build the JSON body for `GET /api/dev/voice-latency`. */
export function buildVoiceLatencyDevPayload(
  tracer: EndToEndLatencyTracer = voiceLatencyTracer,
  limit = 50,
): VoiceLatencyDevPayload {
  return {
    generatedAtEpochMs: Date.now(),
    checkpoints: VOICE_CHECKPOINTS,
    derivedKeys: LATENCY_DERIVED_KEYS,
    openTurnCount: tracer.openTurnCount,
    traces: tracer.recentTraces(limit),
    histograms: tracer.histogramSummaries(),
  };
}

// ---------------------------------------------------------------------------
// VoiceRunMetrics — non-latency accumulator over a long voice run
// ---------------------------------------------------------------------------

/** A per-turn observation fed to `VoiceRunMetrics.recordTurn`. Every field is
 *  optional — a turn that couldn't measure a quantity records it as missing,
 *  never as a fabricated zero (AGENTS.md §3 / §7). */
export interface VoiceTurnMetrics {
  /** DFlash drafter token-acceptance rate (n_drafted_accepted / n_drafted)
   *  for this turn's generation, from the llama-server `/metrics` deltas. */
  dflashAcceptRate?: number | null;
  /** Tokens accepted from the drafter this turn (for an aggregate accept-rate
   *  that weights by token count, not turn count). */
  dflashAccepted?: number | null;
  /** Tokens drafted this turn. */
  dflashDrafted?: number | null;
  /** Structured-decode token-savings % for this turn — tokens the grammar
   *  force-filled ÷ tokens that would otherwise have been generated, ×100
   *  (WS-4's `guided_decode_token_bench.mjs` counter; ≈28% aggregate forced
   *  on the synthetic action set). */
  structuredDecodeTokenSavingsPct?: number | null;
  /** Decode throughput (tokens / second) for this turn's generation. */
  tokensPerSecond?: number | null;
  /** Server resident-set high-water mark in MB at the end of this turn
   *  (`VmHWM` from `/proc/<pid>/status`). */
  serverRssMb?: number | null;
}

export interface VoiceRunMetricsSummary {
  turns: number;
  /** DFlash accept-rate, token-weighted across the run (Σaccepted / Σdrafted);
   *  `null` when nothing was drafted / no drafter present. */
  dflashAcceptRate: number | null;
  dflashAccepted: number;
  dflashDrafted: number;
  /** Per-turn accept-rate histogram (p50/p90/p99 etc. — bounded sample). */
  dflashAcceptRateHistogram: HistogramSummary;
  /** Mean / histogram of the structured-decode token-savings %. */
  structuredDecodeTokenSavingsPct: HistogramSummary;
  /** Mean / histogram of decode tok/s. */
  tokensPerSecond: HistogramSummary;
  /** Server RSS over the run: first / last / max in MB + the `leakSuspected`
   *  flag (true when RSS is monotone non-decreasing across ≥4 turns and grew
   *  by more than `leakGrowthMbThreshold`). */
  rss: {
    firstMb: number | null;
    lastMb: number | null;
    maxMb: number | null;
    samples: number;
    leakSuspected: boolean;
    growthMb: number | null;
  };
}

const VOICE_RUN_HISTOGRAM_CAPACITY = 512;

/**
 * Accumulates the non-latency signals over a long voice run (the duet harness
 * feeds it per-turn). Sibling to `EndToEndLatencyTracer` (which is per-turn
 * spans only). The duet bench report (`voice-duet-bench-<model>.json`) writes
 * `summary()` next to the latency histograms; `eliza1_gates_collect.mjs`
 * ingests the gate-named fields.
 */
export class VoiceRunMetrics {
  private turns = 0;
  private dflashAccepted = 0;
  private dflashDrafted = 0;
  private readonly acceptRateHist = new BoundedHistogram(
    VOICE_RUN_HISTOGRAM_CAPACITY,
  );
  private readonly savingsHist = new BoundedHistogram(
    VOICE_RUN_HISTOGRAM_CAPACITY,
  );
  private readonly tokSecHist = new BoundedHistogram(
    VOICE_RUN_HISTOGRAM_CAPACITY,
  );
  private readonly rssSamples: number[] = [];

  constructor(private readonly opts: { leakGrowthMbThreshold?: number } = {}) {}

  recordTurn(m: VoiceTurnMetrics): void {
    this.turns += 1;
    if (
      typeof m.dflashAccepted === "number" &&
      Number.isFinite(m.dflashAccepted)
    )
      this.dflashAccepted += m.dflashAccepted;
    if (typeof m.dflashDrafted === "number" && Number.isFinite(m.dflashDrafted))
      this.dflashDrafted += m.dflashDrafted;
    if (
      typeof m.dflashAcceptRate === "number" &&
      Number.isFinite(m.dflashAcceptRate)
    )
      this.acceptRateHist.add(m.dflashAcceptRate);
    if (
      typeof m.structuredDecodeTokenSavingsPct === "number" &&
      Number.isFinite(m.structuredDecodeTokenSavingsPct)
    )
      this.savingsHist.add(m.structuredDecodeTokenSavingsPct);
    if (
      typeof m.tokensPerSecond === "number" &&
      Number.isFinite(m.tokensPerSecond)
    )
      this.tokSecHist.add(m.tokensPerSecond);
    if (typeof m.serverRssMb === "number" && Number.isFinite(m.serverRssMb))
      this.rssSamples.push(m.serverRssMb);
  }

  summary(): VoiceRunMetricsSummary {
    const rssN = this.rssSamples.length;
    const firstMb = rssN > 0 ? (this.rssSamples[0] as number) : null;
    const lastMb = rssN > 0 ? (this.rssSamples[rssN - 1] as number) : null;
    const maxMb = rssN > 0 ? Math.max(...this.rssSamples) : null;
    // Leak heuristic: ≥4 samples, monotone non-decreasing, and grew by more
    // than the threshold (default 256 MB). Not a proof — a flag.
    const threshold = this.opts.leakGrowthMbThreshold ?? 256;
    let monotone = rssN >= 4;
    for (let i = 1; i < rssN; i++) {
      if ((this.rssSamples[i] as number) < (this.rssSamples[i - 1] as number)) {
        monotone = false;
        break;
      }
    }
    const growthMb =
      firstMb !== null && lastMb !== null ? lastMb - firstMb : null;
    const leakSuspected = monotone && growthMb !== null && growthMb > threshold;
    return {
      turns: this.turns,
      dflashAcceptRate:
        this.dflashDrafted > 0
          ? this.dflashAccepted / this.dflashDrafted
          : null,
      dflashAccepted: this.dflashAccepted,
      dflashDrafted: this.dflashDrafted,
      dflashAcceptRateHistogram: this.acceptRateHist.summary(),
      structuredDecodeTokenSavingsPct: this.savingsHist.summary(),
      tokensPerSecond: this.tokSecHist.summary(),
      rss: {
        firstMb,
        lastMb,
        maxMb,
        samples: rssN,
        leakSuspected,
        growthMb,
      },
    };
  }

  reset(): void {
    this.turns = 0;
    this.dflashAccepted = 0;
    this.dflashDrafted = 0;
    this.rssSamples.length = 0;
    // Histograms are not reset-able in place; the caller creates a fresh
    // VoiceRunMetrics for a new run. (Kept simple — a long run lives one
    // instance.)
  }
}
