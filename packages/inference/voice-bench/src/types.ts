/**
 * Voice benchmark harness — type definitions.
 *
 * These types describe fixtures (synthetic input scenarios), per-fixture
 * metrics (TTFA, end-to-end latency, etc.), and aggregated bench runs that
 * are written to disk and consumed by CI for regression detection.
 *
 * No runtime behavior here — only structural types.
 */

/** Minimal interface a synthetic audio source implements so the bench
 *  harness can stand in for a real `MicSource` without dragging the full
 *  `@elizaos/app-core` types graph into the bench package. The synthetic
 *  source emits PCM frames at wall-clock rate and lets the runner inject
 *  barge-in / false-EOS events at scripted offsets. */
export interface BenchPcmFrame {
  pcm: Float32Array;
  sampleRate: number;
  timestampMs: number;
}

export interface BenchMicSource {
  readonly sampleRate: number;
  readonly frameSamples: number;
  readonly running: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  onFrame(listener: (frame: BenchPcmFrame) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
}

/** One synthetic scenario the harness will run end-to-end. */
export interface BenchFixture {
  /** Stable id used to key metrics across runs (and the JSON manifest). */
  id: string;
  /** Path to the PCM16 / WAV file the synthetic source plays back. */
  wavPath: string;
  /** Ground-truth transcript the ASR should produce. Used for sanity
   *  checks; not currently part of regression gating. */
  expectedTranscript: string;
  /** If set, the runner will simulate the agent already speaking and
   *  inject a barge-in utterance at this offset (ms) into the run. */
  simulatedBargeInMs?: number;
  /** If set, the runner will splice 400 ms of silence at this offset (ms)
   *  to test the VAD's false-end-of-speech resistance. */
  simulatedFalseEosMs?: number;
  /** Human-readable description for the harness summary table. */
  description: string;
}

export interface BenchFixtureManifest {
  fixtures: BenchFixture[];
}

/** Metrics collected for one fixture. All times are milliseconds. */
export interface BenchMetrics {
  fixtureId: string;
  /** Time-to-first-audio: speech-end → audio-out-first-frame. */
  ttfaMs: number;
  /** End-to-end latency: speech-start → tts-complete (or audio-committed
   *  for the last phrase). */
  e2eLatencyMs: number;
  /** speech-end → audio-out-first-frame, a tighter slice than ttfa for
   *  pipelines that race generation against the end-hangover window. */
  speechEndToFirstAudioMs: number;
  /** When a barge-in was simulated, the time from the barge-in trigger to
   *  the scheduler's hard-stop. Absent when the fixture doesn't simulate
   *  a barge-in. */
  bargeInResponseMs?: number;
  /** Number of `speech-start` events that were promoted to `blip` / never
   *  produced a `speech-end` — i.e. spurious barge-ins. */
  falseBargeInCount: number;
  /** Total drafter tokens proposed across the turn (sum of round draft
   *  windows). */
  draftTokensTotal: number;
  /** Drafter tokens rejected by the verifier (rollback waste). */
  draftTokensWasted: number;
  /**
   * Number of distinct rollback events fired during the run — one per
   * `speech-active` rebound, false-EOS, or barge-in that restores a C1
   * checkpoint. Read from the `rollback-drop` probe events; defaults to
   * `0` when the driver doesn't emit them.
   */
  rollbackCount: number;
  /**
   * Sum of drafter tokens wasted *attributed to rollback events*. Identical
   * to `draftTokensWasted` for the mock driver (every wasted token comes
   * from a rollback); the real-pipeline driver may report a finer split
   * (e.g. verifier-rejected vs. rolled-back) — until then the two numbers
   * align.
   */
  rollbackWasteTokens: number;
  /** Tokens accepted from the DFlash drafter (speculative-decoding stat).
   *  Absent on runs where DFlash isn't wired. */
  dflashAccepted?: number;
  /** Tokens drafted by DFlash (denominator for accept-rate). */
  dflashDrafted?: number;
  /** Peak resident set size during the run, MB. */
  peakRssMb: number;
  /** Peak host CPU percent during the run (one core = 100). */
  peakCpuPct: number;
  /** Peak GPU percent during the run, if available. */
  peakGpuPct?: number;
}

export interface BenchAggregates {
  ttfaP50: number;
  ttfaP95: number;
  e2eP50: number;
  e2eP95: number;
  falseBargeInRate: number;
  rollbackWastePct: number;
}

export interface BenchRun {
  runId: string;
  /** ISO timestamp the run was written. */
  timestamp: string;
  gitSha: string;
  /** Bundle identifier — e.g. `eliza1-1.7b`. */
  bundleId: string;
  /** Inference backend — `metal`, `cuda`, `cpu`, `vulkan`. */
  backend: string;
  /** Free-form device label so multi-host comparisons are tractable. */
  deviceLabel: string;
  fixtures: BenchMetrics[];
  aggregates: BenchAggregates;
}

/**
 * Event names the harness records along the voice loop. Kept structural
 * (string union) so the pipeline files can pass them in without taking a
 * runtime dep on this package.
 */
export type BenchEventName =
  | "speech-start"
  | "speech-pause"
  | "speech-end"
  | "speech-active"
  | "asr-partial"
  | "asr-final"
  | "draft-start"
  | "draft-first-token"
  | "draft-complete"
  | "verifier-start"
  | "verifier-first-token"
  | "verifier-complete"
  | "phrase-emit"
  | "tts-start"
  | "tts-first-pcm"
  | "audio-out-first-frame"
  | "barge-in-trigger"
  | "barge-in-hard-stop"
  | "rollback-drop";

export interface BenchEvent {
  name: BenchEventName;
  /** `performance.now()` domain timestamp, milliseconds. */
  atMs: number;
  /** Optional structured payload — token counts, ranges, etc. */
  data?: Record<string, number | string | boolean>;
}

/**
 * Lightweight callback the pipeline / VAD / phrase chunker invoke when a
 * bench probe is attached. The `data` payload is opaque — the runner
 * interprets it.
 *
 * Pipeline files import this as a `type` only so attaching a probe in a
 * test/bench context never pulls voice-bench into the production graph.
 */
export type VoiceBenchProbe = (
  name: BenchEventName,
  data?: Record<string, number | string | boolean>,
) => void;

/**
 * A bench fixture's *expected* shape after it loads a WAV from disk.
 * Float32 PCM in [-1, 1], mono, at the source sample rate (usually 16k).
 */
export interface BenchAudioPayload {
  pcm: Float32Array;
  sampleRate: number;
  /** Original WAV path, kept for diagnostics. */
  sourcePath?: string;
  /** Total duration in milliseconds. */
  durationMs: number;
}

/**
 * Scripted events the harness injects into a run while audio plays. Times
 * are relative to the start of `run()` (0 = first frame fed to ASR/VAD).
 */
export interface BenchInjection {
  /** Insert `gapMs` of silence into the stream at this offset. */
  silenceGapMs?: number;
  gapMs?: number;
  /** Overlay barge-in audio onto the stream at this offset. */
  bargeInAtMs?: number;
  bargeInAudio?: Float32Array;
  /** Insert a mid-clause breath pause (false-end-of-speech) at this offset. */
  falseEosAtMs?: number;
  falseEosDurationMs?: number;
}

/**
 * Driver contract the harness uses to talk to the voice pipeline. The
 * real pipeline (VoicePipeline + VoiceScheduler) implements this via a
 * thin adapter; for unit tests and CI without a model, MockPipelineDriver
 * implements it deterministically.
 *
 * `run` plays the audio through the pipeline and returns once the pipeline
 * has either finished generating, been cancelled, or hit the token cap.
 * The `probe` callback fires for every BenchEventName the driver
 * observes — the harness records timestamps from these.
 */
export interface PipelineDriver {
  readonly name: string;
  /** Backend label used in result JSON (`metal`, `cuda`, `cpu`, `mock`). */
  readonly backend: string;
  run(args: {
    audio: BenchAudioPayload;
    injection?: BenchInjection;
    probe: VoiceBenchProbe;
    /** Aborted from outside (e.g. CLI Ctrl-C). */
    signal?: AbortSignal;
  }): Promise<BenchDriverResult>;
  /** Best-effort process / kernel teardown. */
  dispose?(): Promise<void>;
}

export interface BenchDriverResult {
  /** Reason the driver loop exited. */
  exitReason: "done" | "token-cap" | "cancelled";
  /** Total drafter tokens proposed across all rounds. */
  draftTokensTotal: number;
  /** Drafter tokens rejected by the verifier (rollback waste). */
  draftTokensWasted: number;
  /** Tokens accepted from DFlash, when DFlash is wired. */
  dflashAccepted?: number;
  /** Tokens drafted by DFlash. */
  dflashDrafted?: number;
  /**
   * Optional: drafter tokens that were thrown away specifically because the
   * voice state machine rolled the slot back to a C1 checkpoint
   * (`rollback-drop` events). When absent, the metrics collector
   * approximates this from the `rollback-drop` probe events. When present,
   * it overrides the approximation.
   */
  rollbackWasteTokens?: number;
}

/**
 * Resource-usage snapshot taken across a run. Peak RSS is always
 * available (process.memoryUsage); CPU/GPU are best-effort and zero on
 * platforms where we can't sample them.
 */
export interface BenchResourceUsage {
  peakRssMb: number;
  peakCpuPct: number;
  peakGpuPct?: number;
}

/**
 * One scenario the runner iterates. Returns the driver-shaped result and
 * the metrics derived by `MetricsCollector`.
 */
export interface BenchScenario {
  id: string;
  description: string;
  fixture: BenchFixture;
  injection?: BenchInjection;
}

/** Compare-to-baseline regression output. */
export interface BenchRegression {
  /** Metric name (TTFA p50, etc.) */
  metric: string;
  baseline: number;
  current: number;
  /** Positive = regression (slower); negative = improvement. */
  pctChange: number;
  severity: "ok" | "warn" | "fail";
  threshold: { warn: number; fail: number };
}

/** Result of a gate check — passes when no `fail` severity rows. */
export interface GateReport {
  passed: boolean;
  rows: BenchRegression[];
  /** Markdown summary suitable for pasting into a PR. */
  markdown: string;
}
