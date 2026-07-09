/**
 * Privacy-safe latency contract for the pendant audio path.
 *
 * Marks describe timing boundaries and counters only. They intentionally carry
 * no transcript text, audio bytes, device address, BLE identifier, user id, or
 * conversation id so the same sink can be enabled in local benches and field
 * evidence without creating sensitive artifacts.
 *
 * `vad.speech` is the first code-observed speech frame. `vad.pending` is the
 * measurable proxy for physical speech end, and is the start boundary for the
 * user-visible latency budgets. Actual physical onset/end remain manual
 * hardware/video boundaries because the runtime cannot observe air-to-mic time.
 */

export const PENDANT_LATENCY_CONTRACT_VERSION = 1 as const;

export const PENDANT_LATENCY_MARKS = [
  "ble.notification",
  "reassembly.frame",
  "decode.start",
  "decode.end",
  "vad.speech",
  "vad.pending",
  "wav.encode.start",
  "wav.encode.end",
  "asr.request",
  "asr.resolve",
  "segment.dispatch",
  "ui.pending",
  "session.follower.propagated",
  "insight.update",
] as const;

export type PendantLatencyMarkName = (typeof PENDANT_LATENCY_MARKS)[number];

export const PENDANT_LATENCY_METRICS = [
  "ble_to_reassembly_ms",
  "reassembly_to_decode_ms",
  "decode_ms",
  "decode_to_vad_speech_ms",
  "vad_speech_to_pending_ms",
  "vad_pending_to_ui_pending_ms",
  "vad_pending_to_asr_resolve_ms",
  "vad_pending_to_follower_propagated_ms",
  "vad_pending_to_insight_update_ms",
  "wav_encode_ms",
  "asr_ms",
  "asr_resolve_to_dispatch_ms",
  "ble_to_dispatch_ms",
] as const;

export type PendantLatencyMetricName = (typeof PENDANT_LATENCY_METRICS)[number];

export interface PendantLatencyMark {
  readonly contractVersion: typeof PENDANT_LATENCY_CONTRACT_VERSION;
  readonly name: PendantLatencyMarkName;
  readonly atMs: number;
  readonly utteranceSeq: number;
  readonly frameSeq?: number;
  readonly packetIndex?: number;
  readonly bytes?: number;
  readonly samples?: number;
  readonly droppedBefore?: number;
  readonly pendingCount?: number;
}

export interface PendantLatencyMetric {
  readonly contractVersion: typeof PENDANT_LATENCY_CONTRACT_VERSION;
  readonly name: PendantLatencyMetricName;
  readonly valueMs: number;
  readonly utteranceSeq: number;
  readonly frameSeq?: number;
}

export interface PendantLatencySink {
  mark(mark: PendantLatencyMark): void;
  metric?(metric: PendantLatencyMetric): void;
  count?(name: string, value: number): void;
}

export type PendantLatencyClock = () => number;

export interface PendantLatencyTraceOptions {
  readonly sink?: PendantLatencySink;
  readonly clock?: PendantLatencyClock;
}

const markNames = new Set<string>(PENDANT_LATENCY_MARKS);

export const PENDANT_LATENCY_TARGET_BUDGETS_MS = {
  vad_pending_to_ui_pending_ms: 100,
  vad_pending_to_asr_resolve_ms: 1_500,
  vad_pending_to_follower_propagated_ms: 1_750,
  vad_pending_to_insight_update_ms: 2_500,
} as const;

export function isPendantLatencyMarkName(
  name: string,
): name is PendantLatencyMarkName {
  return markNames.has(name);
}

export function createPendantLatencyTrace(
  options: PendantLatencyTraceOptions = {},
): PendantLatencyTrace {
  return new PendantLatencyTrace(options.sink, options.clock ?? defaultClock);
}

export class PendantLatencyTrace {
  private readonly utteranceMarks = new Map<
    number,
    Map<PendantLatencyMarkName, PendantLatencyMark>
  >();
  private readonly frameMarks = new Map<
    string,
    Map<PendantLatencyMarkName, PendantLatencyMark>
  >();
  private readonly recentMarks: PendantLatencyMark[] = [];
  /** BLE arrival of the first VAD-positive frame for each active utterance. */
  private readonly speechBleBoundary = new Map<number, PendantLatencyMark>();

  constructor(
    private readonly sink: PendantLatencySink | undefined,
    private readonly clock: PendantLatencyClock,
  ) {}

  mark(
    name: PendantLatencyMarkName,
    detail: Omit<PendantLatencyMark, "contractVersion" | "name" | "atMs">,
  ): PendantLatencyMark {
    const mark = sanitizeMark({
      ...detail,
      contractVersion: PENDANT_LATENCY_CONTRACT_VERSION,
      name,
      atMs: this.clock(),
    });
    this.store(mark);
    try {
      this.sink?.mark(mark);
    } catch {
      // error-policy:J6 diagnostics must never interrupt the audio pipeline.
    }
    this.emitMetricsFor(mark);
    return mark;
  }

  snapshot(): readonly PendantLatencyMark[] {
    return this.recentMarks;
  }

  reset(): void {
    this.utteranceMarks.clear();
    this.frameMarks.clear();
    this.speechBleBoundary.clear();
    this.recentMarks.length = 0;
  }

  completeUtterance(utteranceSeq: number): void {
    const seq = integer(utteranceSeq);
    this.utteranceMarks.delete(seq);
    this.speechBleBoundary.delete(seq);
    for (const key of this.frameMarks.keys()) {
      if (key.startsWith(`${seq}:`)) this.frameMarks.delete(key);
    }
  }

  /** Release one frame after decode/VAD correlation has consumed its marks. */
  completeFrame(utteranceSeq: number, frameSeq: number): void {
    this.frameMarks.delete(frameKey(integer(utteranceSeq), integer(frameSeq)));
  }

  count(name: string, value = 1): void {
    if (!Number.isFinite(value)) return;
    try {
      this.sink?.count?.(name, value);
    } catch {
      // error-policy:J6 diagnostics must never interrupt the audio pipeline.
    }
  }

  private emitMetricsFor(mark: PendantLatencyMark): void {
    if (!this.sink?.metric) return;
    const utteranceMarks = this.utteranceMarks.get(mark.utteranceSeq);
    const frameMarks =
      mark.frameSeq === undefined
        ? undefined
        : this.frameMarks.get(frameKey(mark.utteranceSeq, mark.frameSeq));

    if (mark.name === "reassembly.frame") {
      this.metric(
        "ble_to_reassembly_ms",
        mark,
        findMark(frameMarks, "ble.notification"),
      );
    } else if (mark.name === "decode.start") {
      this.metric(
        "reassembly_to_decode_ms",
        mark,
        findMark(frameMarks, "reassembly.frame"),
      );
    } else if (mark.name === "decode.end") {
      this.metric("decode_ms", mark, findMark(frameMarks, "decode.start"));
    } else if (mark.name === "vad.speech") {
      this.metric(
        "decode_to_vad_speech_ms",
        mark,
        findMark(utteranceMarks, "decode.end"),
      );
      const speechBle = findMark(frameMarks, "ble.notification");
      if (speechBle && !this.speechBleBoundary.has(mark.utteranceSeq)) {
        this.speechBleBoundary.set(mark.utteranceSeq, speechBle);
      }
    } else if (mark.name === "vad.pending") {
      this.metric(
        "vad_speech_to_pending_ms",
        mark,
        findMark(utteranceMarks, "vad.speech"),
      );
    } else if (mark.name === "ui.pending") {
      this.metric(
        "vad_pending_to_ui_pending_ms",
        mark,
        findMark(utteranceMarks, "vad.pending"),
      );
    } else if (mark.name === "wav.encode.end") {
      this.metric(
        "wav_encode_ms",
        mark,
        findMark(utteranceMarks, "wav.encode.start"),
      );
    } else if (mark.name === "asr.resolve") {
      this.metric("asr_ms", mark, findMark(utteranceMarks, "asr.request"));
      this.metric(
        "vad_pending_to_asr_resolve_ms",
        mark,
        findMark(utteranceMarks, "vad.pending"),
      );
    } else if (mark.name === "segment.dispatch") {
      this.metric(
        "asr_resolve_to_dispatch_ms",
        mark,
        findMark(utteranceMarks, "asr.resolve"),
      );
      this.metric(
        "ble_to_dispatch_ms",
        mark,
        this.speechBleBoundary.get(mark.utteranceSeq),
      );
    } else if (mark.name === "session.follower.propagated") {
      this.metric(
        "vad_pending_to_follower_propagated_ms",
        mark,
        findMark(utteranceMarks, "vad.pending"),
      );
    } else if (mark.name === "insight.update") {
      this.metric(
        "vad_pending_to_insight_update_ms",
        mark,
        findMark(utteranceMarks, "vad.pending"),
      );
    }
  }

  private metric(
    name: PendantLatencyMetricName,
    end: PendantLatencyMark,
    start: PendantLatencyMark | undefined,
  ): void {
    if (!start) return;
    const valueMs = end.atMs - start.atMs;
    if (!Number.isFinite(valueMs) || valueMs < 0) return;
    try {
      this.sink?.metric?.({
        contractVersion: PENDANT_LATENCY_CONTRACT_VERSION,
        name,
        valueMs,
        utteranceSeq: end.utteranceSeq,
        frameSeq: end.frameSeq,
      });
    } catch {
      // error-policy:J6 diagnostics must never interrupt the audio pipeline.
    }
  }

  private store(mark: PendantLatencyMark): void {
    const byUtterance =
      this.utteranceMarks.get(mark.utteranceSeq) ??
      new Map<PendantLatencyMarkName, PendantLatencyMark>();
    byUtterance.set(mark.name, mark);
    this.utteranceMarks.set(mark.utteranceSeq, byUtterance);
    if (mark.frameSeq !== undefined) {
      const key = frameKey(mark.utteranceSeq, mark.frameSeq);
      const byFrame =
        this.frameMarks.get(key) ??
        new Map<PendantLatencyMarkName, PendantLatencyMark>();
      if (mark.name !== "ble.notification" || !byFrame.has(mark.name)) {
        byFrame.set(mark.name, mark);
      }
      this.frameMarks.set(key, byFrame);
    }
    this.recentMarks.push(mark);
    if (this.recentMarks.length > 256) this.recentMarks.shift();
  }
}

function findMark(
  marks: ReadonlyMap<PendantLatencyMarkName, PendantLatencyMark> | undefined,
  name: PendantLatencyMarkName,
): PendantLatencyMark | undefined {
  return marks?.get(name);
}

function frameKey(utteranceSeq: number, frameSeq: number): string {
  return `${utteranceSeq}:${frameSeq}`;
}

function sanitizeMark(mark: PendantLatencyMark): PendantLatencyMark {
  return {
    contractVersion: PENDANT_LATENCY_CONTRACT_VERSION,
    name: mark.name,
    atMs: finite(mark.atMs),
    utteranceSeq: integer(mark.utteranceSeq),
    frameSeq: optionalInteger(mark.frameSeq),
    packetIndex: optionalInteger(mark.packetIndex),
    bytes: optionalInteger(mark.bytes),
    samples: optionalInteger(mark.samples),
    droppedBefore: optionalInteger(mark.droppedBefore),
    pendingCount: optionalInteger(mark.pendingCount),
  };
}

function defaultClock(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function integer(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function optionalInteger(value: number | undefined): number | undefined {
  return value === undefined ? undefined : integer(value);
}
