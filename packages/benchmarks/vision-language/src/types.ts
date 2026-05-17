/**
 * Public types for the eliza-1 vision-language bench.
 *
 * The bench is a (tier × benchmark) matrix. A benchmark adapter loads a
 * sample slice (smoke or full), produces a per-sample prediction by calling
 * the supplied vision runtime, scores each prediction, and the runner rolls
 * the per-sample scores into a single report.
 *
 * Same shape across all five adapters (TextVQA, DocVQA, ChartQA, ScreenSpot,
 * OSWorld) so the runner is fully generic.
 */

export type BenchmarkName =
  | "textvqa"
  | "docvqa"
  | "chartqa"
  | "screenspot"
  | "osworld";

export type Eliza1TierId =
  | "eliza-1-0_8b"
  | "eliza-1-2b"
  | "eliza-1-4b"
  | "eliza-1-9b"
  | "eliza-1-27b"
  | "eliza-1-27b-256k";

/** Bounding box in pixel coords: [x_min, y_min, x_max, y_max]. */
export type BBox = readonly [number, number, number, number];

/** A 2D click-point in pixel coords. */
export interface Point {
  x: number;
  y: number;
}

/**
 * Common envelope every benchmark sample shares. The benchmark-specific
 * payload lives on `payload`; the runner only touches the envelope fields.
 */
export interface Sample<TPayload = unknown> {
  /** Benchmark-stable id (matches the upstream dataset id when one exists). */
  id: string;
  /** Local path or `data:` URL to the input image. Empty for action-trace benchmarks. */
  imagePath: string;
  /** Natural-language question or instruction shown to the model. */
  question: string;
  /** Benchmark-specific payload (answer list, bbox, action trace, etc.). */
  payload: TPayload;
}

/**
 * Per-sample prediction emitted by a runtime. Carries everything the scorer
 * needs to grade — a free-text answer for VQA tasks, a click point for
 * grounding, or an action sequence for OSWorld.
 */
export interface Prediction {
  /** Free-text answer (VQA/DocVQA/ChartQA) or empty for grounding tasks. */
  text?: string;
  /** Predicted click point (ScreenSpot). */
  click?: Point;
  /** Predicted action sequence (OSWorld). */
  actions?: PredictedAction[];
  /** Wall time spent producing this prediction in milliseconds. */
  latencyMs: number;
  /** When the runtime errored, this is set and `text` is empty. */
  error?: string;
}

/** A single OSWorld action: minimal subset of OSWorld's `computer_13` space. */
export interface PredictedAction {
  type: "CLICK" | "TYPING" | "HOTKEY" | "SCROLL" | "WAIT" | "DONE" | "FAIL";
  x?: number;
  y?: number;
  text?: string;
  keys?: string[];
}

/** Per-sample score record written into the report. */
export interface SampleResult {
  sampleId: string;
  score: number;
  prediction: Prediction;
  /** Optional debug fields per benchmark (e.g. matched answer, IoU value). */
  detail?: Record<string, unknown>;
}

/**
 * Adapter contract — same shape across all 5 benchmarks. The runner depends
 * only on this interface.
 */
export interface BenchmarkAdapter<TPayload = unknown> {
  readonly name: BenchmarkName;
  /**
   * Return up to `n` samples. Smoke runs pull from the checked-in fixtures
   * under `samples/<name>/`; full runs read the upstream dataset (which the
   * adapter is responsible for locating — see each adapter's docstring).
   */
  loadSamples(n: number, opts: { smoke: boolean }): Promise<Sample<TPayload>[]>;
  /**
   * Score one prediction. The contract is `[0, 1]` where 1 = correct.
   * Adapters MUST not throw — score 0 with an explanation in `detail` when
   * the prediction is malformed.
   */
  scoreOne(
    sample: Sample<TPayload>,
    prediction: Prediction,
  ): { score: number; detail?: Record<string, unknown> };
}

/**
 * What the runner needs from a runtime to grade VQA / grounding samples.
 * For OSWorld the runtime also has to drive an action loop; that is handled
 * by the OSWorld adapter directly via `runActionLoop`.
 */
export interface VisionRuntime {
  /** Stable id used in reports (e.g. "eliza-1-9b"). */
  readonly id: string;
  /**
   * One-shot vision Q&A: returns the model's textual answer for `question`
   * applied to `imagePath`. Wraps `runtime.useModel(IMAGE_DESCRIPTION, ...)`.
   */
  ask(args: {
    imagePath: string;
    question: string;
    /** Cap on output tokens. Adapters use small caps (≤128) for VQA. */
    maxTokens?: number;
  }): Promise<string>;
  /**
   * UI-grounding ask: expects a click coordinate back. Adapters prompt the
   * model to emit "x,y" or JSON `{x, y}`; the runtime returns the parsed
   * coordinate (null when the model's output couldn't be parsed).
   */
  ground?(args: {
    imagePath: string;
    instruction: string;
  }): Promise<Point | null>;
  /**
   * Drive an OSWorld-style action loop: take an instruction + initial
   * screenshot path, return the action sequence. Optional — only the
   * OSWorld adapter calls this.
   */
  runActionLoop?(args: {
    instruction: string;
    initialScreenshotPath: string;
    maxSteps: number;
  }): Promise<PredictedAction[]>;
  /** Optional teardown hook (release model, close session). */
  cleanup?(): Promise<void>;
}

/** Final report shape. */
export interface BenchReport {
  schemaVersion: "vision-language-bench-v1";
  tier: string;
  benchmark: BenchmarkName;
  generatedAt: string;
  sample_count: number;
  /** Aggregated score on `[0, 1]`. */
  score: number;
  /** Qwen2.5-VL or Qwen3-VL official baseline (from `baselines.json`). */
  baseline_score: number | null;
  /** `score - baseline_score`. Null when no baseline is registered. */
  delta: number | null;
  runtime_seconds: number;
  /** Number of samples whose prediction errored. */
  error_count: number;
  /** Per-sample scores for downstream analysis. */
  samples: SampleResult[];
}

/** Catalog of officially-published baselines, keyed by `${tier}::${benchmark}`. */
export interface BaselineEntry {
  tier: string;
  benchmark: BenchmarkName;
  score: number;
  source: string;
}
