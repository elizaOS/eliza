/**
 * Wire and result types for the VLM screenshot Q&A layer (#14544). A reviewing
 * agent hands one image and N questions to `askAboutImage`; every backend
 * (Anthropic Messages, OpenAI-compatible chat) is forced to return the same
 * structured `{answers}` shape so the certify reviewer folds answers into
 * verdicts mechanically. Provenance (model, backend, token usage, latency,
 * retries) rides on every result — a Q&A answer with no recorded model or
 * usage is not admissible evidence. These types are the contract the cache,
 * qa.json writer, and CLI all agree on; widen additively.
 */

/**
 * Vision backend selector. `local` is `openai-compatible` at a swapped base
 * URL; `cli` shells out to an already-authenticated coding-agent CLI (Claude
 * Code or Codex) that views the screenshot and answers — the escape hatch for
 * environments that have an authed CLI but no API key or local server.
 */
export type VisionBackend = "anthropic" | "openai" | "local" | "cli";

/**
 * One question about an image. `expected` is an OPTIONAL reviewer assertion:
 * `'yes'`/`'no'` for a yes/no check, or free text describing what the answer
 * should contain. It is carried through to the record for downstream verdict
 * folding; the model is not told the expected answer (that would bias it).
 */
export interface VisionQuestion {
  id: string;
  question: string;
  expected?: "yes" | "no" | string;
}

/** One structured answer, keyed back to its question by `id`. */
export interface VisionAnswer {
  id: string;
  answer: string;
  /** Model-reported certainty in [0, 1]. */
  confidence: number;
  details: string;
}

/** Original vs downscaled dimensions of the image actually sent to the model. */
export interface ImageDimensions {
  originalWidth: number;
  originalHeight: number;
  sentWidth: number;
  sentHeight: number;
}

/** Token accounting pulled from the provider response (never estimated). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Provenance stamped on every ask result. `retries` counts corrective retries
 * spent forcing conforming JSON (0 on a clean first parse); `cached` is true
 * only when the result came from the content-addressed cache.
 */
export interface VisionProvenance {
  backend: VisionBackend;
  model: string;
  usage: TokenUsage;
  latencyMs: number;
  retries: number;
  timestamp: string;
  cached: boolean;
  dimensions: ImageDimensions;
}

/** Result of one `askAboutImage` call: the answers plus their provenance. */
export interface AskResult {
  answers: VisionAnswer[];
  provenance: VisionProvenance;
}

/** Options for `askAboutImage` / `askBatch`. */
export interface AskOptions {
  /** Force a backend; otherwise resolved from env (see `resolveBackend`). */
  backend?: VisionBackend;
  /** Override the model id; otherwise the backend default. */
  model?: string;
  /** Base URL for the openai-compatible/local path (else env or default). */
  baseUrl?: string;
  /** API key override; otherwise pulled from the backend's env var. */
  apiKey?: string;
  /** Directory that holds `.vision-qa-cache/`; defaults to cwd. */
  cacheDir?: string;
  /** Skip cache read AND write when true. */
  noCache?: boolean;
  /** Longest-edge cap in px before base64 (cost control). Default 1568. */
  maxEdge?: number;
  /** Injectable fetch for deterministic tests. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for deterministic provenance in tests. */
  now?: () => Date;
  /** Per-request timeout in ms. Default 120_000. */
  timeoutMs?: number;
}

/** One entry in a batch ask: an image path plus its questions. */
export interface BatchEntry {
  imagePath: string;
  questions: VisionQuestion[];
}

/** Result of one batch entry, tagged with its source image path. */
export interface BatchResult {
  imagePath: string;
  result: AskResult;
}
