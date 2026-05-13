/**
 * Semantic end-of-turn (EOT) classifier — Tier 3 of the three-tier VAD.
 *
 * Tier 1: RMS energy gate (~10 ms)
 * Tier 2: Silero VAD (~32 ms hop)
 * Tier 3: Semantic EOT classifier — P(turn_complete | transcript_so_far)
 *
 * The classifier operates on the partial transcript text emitted by streaming
 * ASR, not on audio. It returns P(done) ∈ [0, 1]. The voice state machine
 * uses it to:
 *
 *   P(done) ≥ 0.9 AND silence ≥ 50 ms  → commit immediately, skip hangover
 *   P(done) ≥ 0.6 AND silence ≥ 20 ms  → enter PAUSE_TENTATIVE early (start drafter)
 *   P(done) < 0.4                        → extend hangover by 50 ms (mid-clause)
 *
 * Three implementations ship:
 *
 *   `HeuristicEotClassifier` — deterministic, zero-latency, no model load.
 *     This is the baseline; it is always available.
 *
 *   `LiveKitTurnDetector` — local INT8 ONNX LiveKit turn detector. It formats
 *     the latest user transcript with the Qwen chat template, removes the
 *     final `<|im_end|>`, and reads P(`<|im_end|>` next) from the model.
 *
 *   `RemoteEotClassifier` — fail-closed HTTP adapter for a real model server.
 *     It throws on network/parse errors so callers never mistake a synthetic
 *     fallback for a measured turn signal.
 */

import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export type VoiceNextSpeaker = "agent" | "user" | "unknown";

export interface VoiceTurnSignal {
  /** P(user turn complete | transcript/history). */
  endOfTurnProbability: number;
  /**
   * The best turn-taking read from this signal. Text-only EOU models infer
   * this from end-of-turn probability; audio/prosody models can set it
   * directly.
   */
  nextSpeaker: VoiceNextSpeaker;
  /** Whether the agent should begin a response now. */
  agentShouldSpeak: boolean | null;
  /** Implementation/source name for telemetry and trace records. */
  source: "heuristic" | "livekit-turn-detector" | "remote" | "custom";
  /** Optional model/version identifier for telemetry. */
  model?: string;
  /** Text actually scored after normalization/template truncation. */
  transcript: string;
  /** Wall-clock model latency, excluding caller queueing. */
  latencyMs?: number;
}

/**
 * End-of-turn classifier interface. Both implementations satisfy this contract
 * so callers are backend-agnostic.
 */
export interface EotClassifier {
  /** Return P(turn_complete) ∈ [0, 1] for `partialTranscript`. */
  score(partialTranscript: string): Promise<number>;
  /** Return the structured turn signal when the implementation can provide it. */
  signal?(partialTranscript: string): Promise<VoiceTurnSignal>;
}

export function clampProbability(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

export function turnSignalFromProbability(args: {
  probability: number;
  transcript: string;
  source: VoiceTurnSignal["source"];
  model?: string;
  latencyMs?: number;
}): VoiceTurnSignal {
  const p = clampProbability(args.probability);
  const nextSpeaker: VoiceNextSpeaker =
    p >= EOT_TENTATIVE_THRESHOLD
      ? "agent"
      : p < EOT_MID_CLAUSE_THRESHOLD
        ? "user"
        : "unknown";
  return {
    endOfTurnProbability: p,
    nextSpeaker,
    agentShouldSpeak:
      nextSpeaker === "agent" ? true : nextSpeaker === "user" ? false : null,
    source: args.source,
    ...(args.model ? { model: args.model } : {}),
    transcript: args.transcript,
    ...(args.latencyMs !== undefined ? { latencyMs: args.latencyMs } : {}),
  };
}

// ---------------------------------------------------------------------------
// Heuristic baseline
// ---------------------------------------------------------------------------

/**
 * Rules-of-thumb EOT classifier. The rules fire in priority order; the first
 * match wins.
 *
 * Priority  Signal                                       P(done)
 * --------  -------------------------------------------  -------
 *   1       Sentence-final punctuation (. ! ?)            0.95
 *   2       Question-tag words ("right?", "yeah?", "ok?") 0.85
 *   3       Short utterance (< 3 words)                   0.70
 *   4       Trailing conjunction (and/but/or/because/…)   0.15
 *   5       Last word is a preposition or article         0.20
 *   6       No signal                                     0.50
 */
export class HeuristicEotClassifier implements EotClassifier {
  /** Conjunctions that strongly suggest the user is mid-clause. */
  private static readonly TRAILING_CONJUNCTIONS = new Set([
    "and",
    "but",
    "or",
    "nor",
    "yet",
    "so",
    "because",
    "although",
    "though",
    "while",
    "whereas",
    "if",
    "unless",
    "until",
    "since",
    "when",
    "where",
    "which",
    "that",
    "who",
    "whom",
    "whose",
  ]);

  /** Prepositions and articles that suggest an incomplete NP follows. */
  private static readonly TRAILING_INCOMPLETE = new Set([
    "a",
    "an",
    "the",
    "to",
    "of",
    "in",
    "on",
    "at",
    "by",
    "for",
    "with",
    "from",
    "into",
    "about",
    "through",
    "between",
    "against",
    "during",
    "before",
    "after",
    "without",
    "under",
    "over",
    "above",
    "below",
    "around",
    "beside",
    "beyond",
    "like",
    "near",
    "past",
    "via",
  ]);

  /** Question-tag suffixes that end an utterance (case-insensitive). */
  private static readonly QUESTION_TAGS = [
    "right?",
    "yeah?",
    "ok?",
    "okay?",
    "right",
    "yeah",
    "correct?",
    "correct",
    "hm?",
    "huh?",
    "eh?",
  ];

  score(partialTranscript: string): Promise<number> {
    const text = partialTranscript.trim();
    if (text.length === 0) return Promise.resolve(0.5);

    // Rule 1 — sentence-final punctuation.
    if (/[.!?]$/.test(text)) {
      return Promise.resolve(0.95);
    }

    // Rule 2 — question-tag words at the end.
    const lower = text.toLowerCase();
    for (const tag of HeuristicEotClassifier.QUESTION_TAGS) {
      if (lower.endsWith(tag)) return Promise.resolve(0.85);
    }

    // Split into words for word-level checks.
    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9'\s-]/gi, "")
      .split(/\s+/)
      .filter(Boolean);
    if (words.length === 0) return Promise.resolve(0.5);

    const lastWord = words[words.length - 1].replace(/[',;:-]+$/, "");

    // Rule 3 — short utterance (< 3 words) → likely complete.
    if (words.length < 3) return Promise.resolve(0.7);

    // Rule 4 — trailing conjunction → mid-clause.
    if (HeuristicEotClassifier.TRAILING_CONJUNCTIONS.has(lastWord)) {
      return Promise.resolve(0.15);
    }

    // Rule 5 — trailing preposition or article → incomplete NP.
    if (HeuristicEotClassifier.TRAILING_INCOMPLETE.has(lastWord)) {
      return Promise.resolve(0.2);
    }

    // Rule 6 — no signal.
    return Promise.resolve(0.5);
  }

  async signal(partialTranscript: string): Promise<VoiceTurnSignal> {
    return turnSignalFromProbability({
      probability: await this.score(partialTranscript),
      transcript: partialTranscript.trim(),
      source: "heuristic",
      model: "heuristic-v1",
    });
  }
}

// ---------------------------------------------------------------------------
// Local LiveKit ONNX turn detector
// ---------------------------------------------------------------------------

type ChatMessage = { role: "user" | "assistant"; content: string };

interface TokenTensorLike {
  data?: BigInt64Array | BigUint64Array | Int32Array | number[] | bigint[];
  dims?: number[];
}

interface TokenizerOutputLike {
  input_ids?: TokenTensorLike | number[] | bigint[] | number[][];
}

interface CallableTokenizer {
  apply_chat_template(
    messages: ChatMessage[],
    options: {
      add_generation_prompt?: boolean;
      tokenize?: boolean;
      add_special_tokens?: boolean;
    },
  ): string;
  (
    text: string,
    options: {
      add_special_tokens?: boolean;
      max_length?: number;
      truncation?: boolean;
    },
  ): Promise<TokenizerOutputLike>;
}

type OrtModule = typeof import("onnxruntime-node");
type OrtSession = import("onnxruntime-node").InferenceSession;

export interface LiveKitTurnDetectorOptions {
  /** Directory containing tokenizer files and the ONNX graph. */
  modelDir?: string;
  /** ONNX filename inside `modelDir`. Default: model_quantized.onnx. */
  onnxFilename?: string;
  /** Max history tokens. LiveKit's published runner uses 128. */
  maxHistoryTokens?: number;
  /** CPU execution threads for ONNX Runtime. Default: 2. */
  intraOpNumThreads?: number;
  /** Optional model label for telemetry. */
  model?: string;
}

export const DEFAULT_LIVEKIT_TURN_DETECTOR_DIR = path.join(
  homedir(),
  ".eliza",
  "local-inference",
  "models",
  "turn-detector",
  "livekit-turn-detector",
);

const DEFAULT_LIVEKIT_TURN_DETECTOR_ONNX = "model_quantized.onnx";
const LIVEKIT_IM_END_TOKEN = "<|im_end|>";

/**
 * Local LiveKit text turn detector. This is the same inference contract as
 * the LiveKit Agents plugin, adapted to the main-branch HF export where the
 * ONNX graph returns logits instead of a pre-sigmoided scalar.
 */
export class LiveKitTurnDetector implements EotClassifier {
  private readonly modelDir: string;
  private readonly onnxPath: string;
  private readonly maxHistoryTokens: number;
  private readonly intraOpNumThreads: number;
  private readonly model: string;
  private ready:
    | Promise<{
        ort: OrtModule;
        session: OrtSession;
        tokenizer: CallableTokenizer;
        imEndTokenId: number;
      }>
    | null = null;

  constructor(opts: LiveKitTurnDetectorOptions = {}) {
    this.modelDir = opts.modelDir ?? DEFAULT_LIVEKIT_TURN_DETECTOR_DIR;
    this.onnxPath = path.join(
      this.modelDir,
      opts.onnxFilename ?? DEFAULT_LIVEKIT_TURN_DETECTOR_ONNX,
    );
    this.maxHistoryTokens = opts.maxHistoryTokens ?? 128;
    this.intraOpNumThreads = opts.intraOpNumThreads ?? 2;
    this.model = opts.model ?? "livekit/turn-detector";
  }

  async score(partialTranscript: string): Promise<number> {
    return (await this.signal(partialTranscript)).endOfTurnProbability;
  }

  async signal(partialTranscript: string): Promise<VoiceTurnSignal> {
    const started = performance.now();
    const loaded = await this.load();
    const transcript = normalizeTurnDetectorText(partialTranscript);
    const text = formatLiveKitTurnDetectorPrompt(loaded.tokenizer, transcript);
    const encoded = await loaded.tokenizer(text, {
      add_special_tokens: false,
      max_length: this.maxHistoryTokens,
      truncation: true,
    });
    const { data, dims } = tokenIdsToBigInt64(encoded);
    const feeds = {
      input_ids: new loaded.ort.Tensor("int64", data, dims),
    };
    const outputs = await loaded.session.run(feeds);
    const outputName = loaded.session.outputNames[0];
    const tensor =
      (outputName ? outputs[outputName] : undefined) ??
      Object.values(outputs)[0];
    if (!tensor) {
      throw new Error("[voice] LiveKit turn detector returned no outputs.");
    }
    const probability = probabilityFromOnnxOutput(
      tensor,
      loaded.imEndTokenId,
    );
    return turnSignalFromProbability({
      probability,
      transcript,
      source: "livekit-turn-detector",
      model: this.model,
      latencyMs: performance.now() - started,
    });
  }

  private load(): Promise<{
    ort: OrtModule;
    session: OrtSession;
    tokenizer: CallableTokenizer;
    imEndTokenId: number;
  }> {
    this.ready ??= this.loadInner();
    return this.ready;
  }

  private async loadInner(): Promise<{
    ort: OrtModule;
    session: OrtSession;
    tokenizer: CallableTokenizer;
    imEndTokenId: number;
  }> {
    await Promise.all([
      access(this.onnxPath),
      access(path.join(this.modelDir, "tokenizer.json")),
    ]);
    const [{ AutoTokenizer }, ort] = await Promise.all([
      import("@huggingface/transformers"),
      import("onnxruntime-node"),
    ]);
    const tokenizer = (await AutoTokenizer.from_pretrained(this.modelDir, {
      local_files_only: true,
      truncation_side: "left",
    })) as CallableTokenizer;
    const imEnd = await tokenizer(LIVEKIT_IM_END_TOKEN, {
      add_special_tokens: false,
    });
    const imEndIds = tokenIdsToBigInt64(imEnd).data;
    const imEndTokenId = Number(imEndIds[0]);
    if (!Number.isInteger(imEndTokenId)) {
      throw new Error(
        "[voice] LiveKit turn detector tokenizer did not expose <|im_end|>.",
      );
    }
    const session = await ort.InferenceSession.create(this.onnxPath, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      interOpNumThreads: 1,
      intraOpNumThreads: this.intraOpNumThreads,
    });
    if (!session.inputNames.includes("input_ids")) {
      throw new Error(
        `[voice] LiveKit turn detector graph is missing input_ids (inputs: ${session.inputNames.join(", ")}).`,
      );
    }
    return { ort, session, tokenizer, imEndTokenId };
  }
}

export async function createBundledLiveKitTurnDetector(
  opts: LiveKitTurnDetectorOptions = {},
): Promise<LiveKitTurnDetector | null> {
  const modelDir =
    opts.modelDir ??
    process.env.ELIZA_TURN_DETECTOR_MODEL_DIR ??
    DEFAULT_LIVEKIT_TURN_DETECTOR_DIR;
  const onnxFilename =
    opts.onnxFilename ??
    process.env.ELIZA_TURN_DETECTOR_ONNX ??
    DEFAULT_LIVEKIT_TURN_DETECTOR_ONNX;
  try {
    await Promise.all([
      access(path.join(modelDir, onnxFilename)),
      access(path.join(modelDir, "tokenizer.json")),
    ]);
  } catch {
    return null;
  }
  return new LiveKitTurnDetector({
    ...opts,
    modelDir,
    onnxFilename,
  });
}

function normalizeTurnDetectorText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\-\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatLiveKitTurnDetectorPrompt(
  tokenizer: CallableTokenizer,
  transcript: string,
): string {
  const templated = tokenizer.apply_chat_template(
    [{ role: "user", content: transcript }],
    {
      add_generation_prompt: false,
      tokenize: false,
      add_special_tokens: false,
    },
  );
  const ix = templated.lastIndexOf(LIVEKIT_IM_END_TOKEN);
  return ix >= 0 ? templated.slice(0, ix) : templated;
}

function tokenIdsToBigInt64(encoded: TokenizerOutputLike): {
  data: BigInt64Array;
  dims: number[];
} {
  const ids = encoded.input_ids;
  if (!ids) throw new Error("[voice] tokenizer output missing input_ids.");
  if (isTensorLike(ids) && ids.data) {
    const dims = ids.dims ?? [1, ids.data.length];
    return {
      data: toBigInt64Array(ids.data),
      dims,
    };
  }
  if (Array.isArray(ids)) {
    const flattened = ids.flat() as Array<number | bigint>;
    return {
      data: toBigInt64Array(flattened),
      dims: Array.isArray(ids[0]) ? [ids.length, flattened.length] : [1, ids.length],
    };
  }
  throw new Error("[voice] unsupported tokenizer input_ids shape.");
}

function isTensorLike(value: unknown): value is TokenTensorLike {
  return typeof value === "object" && value !== null && "data" in value;
}

function toBigInt64Array(
  input: BigInt64Array | BigUint64Array | Int32Array | number[] | bigint[],
): BigInt64Array {
  if (input instanceof BigInt64Array) return input;
  return BigInt64Array.from(Array.from(input, (v) => BigInt(v)));
}

function probabilityFromOnnxOutput(
  tensor: import("onnxruntime-node").Tensor,
  imEndTokenId: number,
): number {
  const data = tensor.data;
  if (!(data instanceof Float32Array || data instanceof Float64Array)) {
    throw new Error(
      `[voice] LiveKit turn detector output must be float logits/probabilities, got ${tensor.type}.`,
    );
  }
  const dims = tensor.dims;
  if (dims.length >= 3) {
    const vocabSize = dims[dims.length - 1];
    if (imEndTokenId < 0 || imEndTokenId >= vocabSize) {
      throw new Error(
        `[voice] <|im_end|> token id ${imEndTokenId} outside detector vocab ${vocabSize}.`,
      );
    }
    const sequenceLength = dims[dims.length - 2];
    const offset = (sequenceLength - 1) * vocabSize;
    return softmaxProbability(data, offset, vocabSize, imEndTokenId);
  }
  const last = data[data.length - 1];
  return clampProbability(last);
}

function softmaxProbability(
  logits: Float32Array | Float64Array,
  offset: number,
  length: number,
  tokenId: number,
): number {
  let max = -Infinity;
  for (let i = 0; i < length; i++) {
    const value = logits[offset + i];
    if (value > max) max = value;
  }
  let sum = 0;
  for (let i = 0; i < length; i++) {
    sum += Math.exp(logits[offset + i] - max);
  }
  return clampProbability(Math.exp(logits[offset + tokenId] - max) / sum);
}

// ---------------------------------------------------------------------------
// Remote model adapter
// ---------------------------------------------------------------------------

export interface RemoteEotClassifierOptions {
  /**
   * HTTP endpoint to POST the partial transcript to. Expected to return JSON
   * with a `p_done` field: `{ "p_done": 0.92 }`.
   *
   * Example: LiveKit turn-detector inference endpoint or a custom model server.
   */
  endpoint: string;
  /**
   * Timeout in milliseconds for each HTTP request. Default 200 ms — the
   * classifier must be faster than the silence hangover it's trying to beat.
   */
  timeoutMs?: number;
  /** Optional model label for telemetry. */
  model?: string;
}

/**
 * Remote EOT classifier. POSTs `{ transcript: string }` to `endpoint`
 * and expects `{ p_done: number }` back.
 *
 * Intended to be wired to a real LiveKit turn-detector HTTP API or a custom
 * model inference server. This adapter fails closed: no fallback score is
 * manufactured on network or parse errors.
 */
export class RemoteEotClassifier implements EotClassifier {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly model: string;

  constructor(opts: RemoteEotClassifierOptions) {
    this.endpoint = opts.endpoint;
    this.timeoutMs = opts.timeoutMs ?? 200;
    this.model = opts.model ?? "remote-eot";
  }

  async score(partialTranscript: string): Promise<number> {
    return (await this.signal(partialTranscript)).endOfTurnProbability;
  }

  async signal(partialTranscript: string): Promise<VoiceTurnSignal> {
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: partialTranscript }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `[voice] Remote EOT classifier failed: HTTP ${response.status} ${response.statusText}`,
        );
      }
      const json = (await response.json()) as unknown;
      if (
        typeof json === "object" &&
        json !== null &&
        "p_done" in json &&
        typeof (json as Record<string, unknown>).p_done === "number"
      ) {
        const p = (json as { p_done: number }).p_done;
        return turnSignalFromProbability({
          probability: p,
          transcript: partialTranscript.trim(),
          source: "remote",
          model: this.model,
          latencyMs: performance.now() - started,
        });
      }
      throw new Error(
        "[voice] Remote EOT classifier response missing numeric p_done.",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Thresholds (shared constants so tests and state machine stay in sync)
// ---------------------------------------------------------------------------

/** P(done) ≥ this AND silence ≥ EOT_COMMIT_SILENCE_MS → commit immediately. */
export const EOT_COMMIT_THRESHOLD = 0.9;

/** P(done) ≥ this AND silence ≥ EOT_TENTATIVE_SILENCE_MS → enter PAUSE_TENTATIVE early. */
export const EOT_TENTATIVE_THRESHOLD = 0.6;

/** P(done) < this → extend hangover by EOT_HANGOVER_EXTENSION_MS. */
export const EOT_MID_CLAUSE_THRESHOLD = 0.4;

/** Minimum silence (ms) required alongside P ≥ EOT_COMMIT_THRESHOLD to commit. */
export const EOT_COMMIT_SILENCE_MS = 50;

/** Minimum silence (ms) required alongside P ≥ EOT_TENTATIVE_THRESHOLD to start drafter. */
export const EOT_TENTATIVE_SILENCE_MS = 20;

/** How many ms to add to the pause hangover when P < EOT_MID_CLAUSE_THRESHOLD. */
export const EOT_HANGOVER_EXTENSION_MS = 50;
