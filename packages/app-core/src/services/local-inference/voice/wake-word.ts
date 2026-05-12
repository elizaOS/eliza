/**
 * Wake-word detection (openWakeWord) — opt-in, local-mode only.
 *
 * Per `packages/inference/AGENTS.md` §1 + the three-mode rules (§1, §5):
 *   - openWakeWord (Apache-2.0, ~3 MB across three ONNX graphs) ships in
 *     the bundle but is **opt-in**: voice mode works without it
 *     (push-to-talk / VAD-gated).
 *   - It is **local-mode only**. In `cloud` mode the surface is hidden
 *     *and inert* (hide-not-disable §5): the model is not loaded, the
 *     setting is rejected by the API, no background job runs it.
 *   - Detections feed the same place a push-to-talk press would: they arm
 *     a listening window that the VAD gate then bounds.
 *
 * openWakeWord is a three-stage streaming pipeline:
 *   1. melspectrogram.onnx — 16 kHz PCM → log-mel frames (32 mel bins,
 *      10 ms hop). Streamed: each 1280-sample (80 ms) chunk yields 8 new
 *      mel frames (a 480-sample lead-in is carried frame-to-frame).
 *   2. embedding_model.onnx — a sliding 76-mel-frame window → a 96-dim
 *      embedding, recomputed every 8 mel frames (i.e. once per chunk).
 *   3. <wakeword>.onnx — the last 16 embeddings → P(wake) in [0, 1].
 * Mel features are rescaled `x/10 + 2` before stage 2, matching upstream
 * openWakeWord. State (audio tail, mel ring, embedding ring) is carried
 * across `scoreFrame` calls; `reset()` clears it at the start of a
 * listening session.
 *
 * No test-only fallback model here (unlike VAD's energy gate) because a
 * wake word has no meaningful heuristic stand-in; tests inject a scripted
 * `WakeWordModel`.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { localInferenceRoot } from "../paths";
import {
  loadOnnxRuntime,
  OnnxRuntimeUnavailableError,
  type OrtInferenceSession,
  type OrtTensorCtor,
} from "./onnx-runtime";

/** Directory holding the bundled openWakeWord ONNX graphs inside a bundle. */
export const OPENWAKEWORD_DIR_REL_PATH = "wake";
/** Shared melspectrogram front-end (one per bundle, model-agnostic). */
export const OPENWAKEWORD_MELSPEC_REL_PATH = path.join(
  OPENWAKEWORD_DIR_REL_PATH,
  "melspectrogram.onnx",
);
/** Shared audio→embedding model (one per bundle, model-agnostic). */
export const OPENWAKEWORD_EMBEDDING_REL_PATH = path.join(
  OPENWAKEWORD_DIR_REL_PATH,
  "embedding_model.onnx",
);
/** Default wake-word head shipped with a voice bundle (the wake phrase). */
export const OPENWAKEWORD_DEFAULT_HEAD = "hey-eliza";
/** Relative path of the default wake-word head ONNX inside a bundle. */
export const OPENWAKEWORD_DEFAULT_HEAD_REL_PATH = path.join(
  OPENWAKEWORD_DIR_REL_PATH,
  `${OPENWAKEWORD_DEFAULT_HEAD}.onnx`,
);

/**
 * Heads that are placeholders, not the trained Eliza-1 wake phrase.
 *
 * The `hey-eliza.onnx` currently shipped in bundles is the upstream
 * openWakeWord `hey_jarvis` head renamed — it fires on "hey jarvis", NOT
 * "hey eliza". Wake word is opt-in and off by default, so this is an
 * experimental surface until a real head is trained on the approved
 * Eliza-1 wake phrase (see
 * `packages/inference/reports/porting/2026-05-11/wakeword-head-plan.md`).
 * The engine emits a one-time warning whenever a session enables a
 * placeholder head so nobody mistakes it for a finished feature.
 */
export const OPENWAKEWORD_PLACEHOLDER_HEADS: ReadonlySet<string> = new Set([
  "hey-eliza",
  "hey_jarvis",
]);

export function isPlaceholderWakeWordHead(head: string): boolean {
  return OPENWAKEWORD_PLACEHOLDER_HEADS.has(head.trim());
}

/** Audio chunk the streaming pipeline consumes, in samples (80 ms @ 16 kHz). */
const FRAME_SAMPLES = 1280;
/** Samples of audio carried between chunks so melspec frames line up. */
const MEL_LEAD_IN_SAMPLES = 480;
/** Mel bins per frame (openWakeWord melspectrogram output width). */
const MEL_BINS = 32;
/** Mel frames the embedding model windows over. */
const EMBEDDING_WINDOW_FRAMES = 76;
/** Mel frames between successive embedding computations (one per 80 ms chunk). */
const EMBEDDING_HOP_FRAMES = 8;
/** Embedding dimension (openWakeWord embedding model output width). */
const EMBEDDING_DIM = 96;
/** Embeddings the wake-word head windows over. */
const HEAD_WINDOW_EMBEDDINGS = 16;
/** Cap on the retained mel ring (a touch over the embedding window). */
const MEL_RING_CAP_FRAMES = EMBEDDING_WINDOW_FRAMES + 4 * EMBEDDING_HOP_FRAMES;
/** Cap on the retained embedding ring (a touch over the head window). */
const EMBEDDING_RING_CAP = HEAD_WINDOW_EMBEDDINGS + 8;

/**
 * Per-frame wake-word probability source. openWakeWord runs on 80 ms
 * frames of 16 kHz audio; `scoreFrame` takes one PCM frame and returns the
 * latest P(wake) in [0, 1] (the head only re-runs once enough context has
 * accumulated — early frames return 0). Stateful (the streaming front-end
 * carries its buffers); `reset()` clears it. ONNX inference is async, so
 * `scoreFrame` is too.
 */
export interface WakeWordModel {
  readonly frameSamples: number;
  readonly sampleRate: number;
  scoreFrame(frame: Float32Array): Promise<number>;
  reset(): void;
}

export interface WakeWordConfig {
  /** P(wake) above this fires a detection. openWakeWord default ~0.5. */
  threshold?: number;
  /**
   * Refractory frames after a detection during which no new detection
   * fires (debounce a single utterance into one event).
   */
  refractoryFrames?: number;
}

const DEFAULTS: Required<WakeWordConfig> = {
  threshold: 0.5,
  refractoryFrames: 25, // ~2 s @ 80 ms frames
};

/** Thrown when the openWakeWord backend cannot be loaded — missing
 *  `onnxruntime-node` or a corrupt graph. NOT thrown for an absent
 *  bundled model (that is "wake word unavailable for this bundle", not a
 *  broken bundle — `resolveWakeWordModel` returns null instead). */
export class WakeWordUnavailableError extends Error {
  readonly code: "ort-missing" | "model-load-failed";
  constructor(code: WakeWordUnavailableError["code"], message: string) {
    super(message);
    this.name = "WakeWordUnavailableError";
    this.code = code;
  }
}

async function loadOrt() {
  try {
    return await loadOnnxRuntime();
  } catch (err) {
    if (err instanceof OnnxRuntimeUnavailableError) {
      throw new WakeWordUnavailableError(
        "ort-missing",
        `${err.message} Install it to enable on-device wake-word detection; push-to-talk and VAD-gated listening keep working without it.`,
      );
    }
    throw err;
  }
}

/** Paths to the three ONNX graphs that make up one wake-word model. */
export interface WakeWordModelPaths {
  /** Shared melspectrogram front-end. */
  melspectrogram: string;
  /** Shared audio→embedding model. */
  embedding: string;
  /** The wake-phrase head. */
  head: string;
}

/**
 * The real openWakeWord streaming detector. Owns three `InferenceSession`s
 * (melspec / embedding / head), a carried-over audio tail, a mel-frame ring
 * and an embedding ring. `scoreFrame` consumes exactly `frameSamples`
 * (1280) samples at 16 kHz and returns the most recent head probability.
 */
export class OpenWakeWordModel implements WakeWordModel {
  readonly frameSamples = FRAME_SAMPLES;
  readonly sampleRate = 16_000;

  private audioTail = new Float32Array(MEL_LEAD_IN_SAMPLES);
  private melRing: Float32Array[] = [];
  private framesSinceEmbedding = 0;
  private embeddingRing: Float32Array[] = [];
  private lastProbability = 0;

  private constructor(
    private readonly melspec: OrtInferenceSession,
    private readonly embedding: OrtInferenceSession,
    private readonly head: OrtInferenceSession,
    private readonly Tensor: OrtTensorCtor,
    private readonly melInputName: string,
    private readonly melOutputName: string,
    private readonly embeddingInputName: string,
    private readonly embeddingOutputName: string,
    private readonly headInputName: string,
    private readonly headOutputName: string,
  ) {}

  /**
   * Load a wake-word model from its three ONNX graphs. Throws
   * `WakeWordUnavailableError` when `onnxruntime-node` is missing or a
   * graph fails to load.
   */
  static async load(paths: WakeWordModelPaths): Promise<OpenWakeWordModel> {
    const ort = await loadOrt();
    let melspec: OrtInferenceSession;
    let embedding: OrtInferenceSession;
    let head: OrtInferenceSession;
    try {
      [melspec, embedding, head] = await Promise.all([
        ort.InferenceSession.create(paths.melspectrogram),
        ort.InferenceSession.create(paths.embedding),
        ort.InferenceSession.create(paths.head),
      ]);
    } catch (err) {
      throw new WakeWordUnavailableError(
        "model-load-failed",
        `[wake-word] failed to load openWakeWord graphs (${paths.melspectrogram} / ${paths.embedding} / ${paths.head}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return new OpenWakeWordModel(
      melspec,
      embedding,
      head,
      ort.Tensor,
      requireName(melspec.inputNames, "melspectrogram input"),
      requireName(melspec.outputNames, "melspectrogram output"),
      requireName(embedding.inputNames, "embedding input"),
      requireName(embedding.outputNames, "embedding output"),
      requireName(head.inputNames, "wake-word head input"),
      requireName(head.outputNames, "wake-word head output"),
    );
  }

  reset(): void {
    this.audioTail = new Float32Array(MEL_LEAD_IN_SAMPLES);
    this.melRing = [];
    this.framesSinceEmbedding = 0;
    this.embeddingRing = [];
    this.lastProbability = 0;
  }

  async scoreFrame(frame: Float32Array): Promise<number> {
    if (frame.length !== FRAME_SAMPLES) {
      throw new Error(
        `[wake-word] OpenWakeWordModel.scoreFrame expects ${FRAME_SAMPLES} samples; got ${frame.length}`,
      );
    }
    await this.ingestMelFrames(frame);
    const embeddingsToRun = this.drainEmbeddingWindows();
    for (const window of embeddingsToRun) {
      await this.appendEmbedding(window);
      await this.runHeadIfReady();
    }
    return this.lastProbability;
  }

  private async ingestMelFrames(chunk: Float32Array): Promise<void> {
    const input = new Float32Array(MEL_LEAD_IN_SAMPLES + FRAME_SAMPLES);
    input.set(this.audioTail, 0);
    input.set(chunk, MEL_LEAD_IN_SAMPLES);
    this.audioTail = chunk.slice(FRAME_SAMPLES - MEL_LEAD_IN_SAMPLES);

    const out = await this.melspec.run({
      [this.melInputName]: new this.Tensor("float32", input, [1, input.length]),
    });
    const tensor = out[this.melOutputName];
    if (!tensor || !(tensor.data instanceof Float32Array)) {
      throw new Error("[wake-word] melspectrogram output was not float32");
    }
    const dims = tensor.dims;
    const frames = dims[dims.length - 2] ?? 0;
    const bins = dims[dims.length - 1] ?? 0;
    if (bins !== MEL_BINS) {
      throw new Error(
        `[wake-word] melspectrogram produced ${bins} mel bins; expected ${MEL_BINS}`,
      );
    }
    const data = tensor.data;
    for (let i = 0; i < frames; i++) {
      const frame = new Float32Array(MEL_BINS);
      for (let j = 0; j < MEL_BINS; j++) {
        // openWakeWord rescales the melspectrogram before the embedding model.
        frame[j] = data[i * MEL_BINS + j] / 10 + 2;
      }
      this.melRing.push(frame);
      this.framesSinceEmbedding++;
    }
    if (this.melRing.length > MEL_RING_CAP_FRAMES) {
      this.melRing = this.melRing.slice(
        this.melRing.length - MEL_RING_CAP_FRAMES,
      );
    }
  }

  /** Pull every embedding window that is due (76-frame window, 8-frame hop). */
  private drainEmbeddingWindows(): Float32Array[] {
    const windows: Float32Array[] = [];
    while (
      this.melRing.length >= EMBEDDING_WINDOW_FRAMES &&
      this.framesSinceEmbedding >= EMBEDDING_HOP_FRAMES
    ) {
      const start = this.melRing.length - EMBEDDING_WINDOW_FRAMES;
      const flat = new Float32Array(EMBEDDING_WINDOW_FRAMES * MEL_BINS);
      for (let i = 0; i < EMBEDDING_WINDOW_FRAMES; i++) {
        flat.set(this.melRing[start + i], i * MEL_BINS);
      }
      windows.push(flat);
      this.framesSinceEmbedding -= EMBEDDING_HOP_FRAMES;
    }
    return windows;
  }

  private async appendEmbedding(melWindow: Float32Array): Promise<void> {
    const out = await this.embedding.run({
      [this.embeddingInputName]: new this.Tensor("float32", melWindow, [
        1,
        EMBEDDING_WINDOW_FRAMES,
        MEL_BINS,
        1,
      ]),
    });
    const tensor = out[this.embeddingOutputName];
    if (!tensor || !(tensor.data instanceof Float32Array)) {
      throw new Error("[wake-word] embedding model output was not float32");
    }
    if (tensor.data.length < EMBEDDING_DIM) {
      throw new Error(
        `[wake-word] embedding model produced ${tensor.data.length} values; expected >= ${EMBEDDING_DIM}`,
      );
    }
    this.embeddingRing.push(tensor.data.slice(0, EMBEDDING_DIM));
    if (this.embeddingRing.length > EMBEDDING_RING_CAP) {
      this.embeddingRing = this.embeddingRing.slice(
        this.embeddingRing.length - EMBEDDING_RING_CAP,
      );
    }
  }

  private async runHeadIfReady(): Promise<void> {
    if (this.embeddingRing.length < HEAD_WINDOW_EMBEDDINGS) return;
    const start = this.embeddingRing.length - HEAD_WINDOW_EMBEDDINGS;
    const flat = new Float32Array(HEAD_WINDOW_EMBEDDINGS * EMBEDDING_DIM);
    for (let i = 0; i < HEAD_WINDOW_EMBEDDINGS; i++) {
      flat.set(this.embeddingRing[start + i], i * EMBEDDING_DIM);
    }
    const out = await this.head.run({
      [this.headInputName]: new this.Tensor("float32", flat, [
        1,
        HEAD_WINDOW_EMBEDDINGS,
        EMBEDDING_DIM,
      ]),
    });
    const tensor = out[this.headOutputName];
    if (!tensor || !(tensor.data instanceof Float32Array)) {
      throw new Error("[wake-word] wake-word head output was not float32");
    }
    const p = tensor.data[0] ?? 0;
    this.lastProbability = Math.min(1, Math.max(0, p));
  }
}

function requireName(names: readonly string[], what: string): string {
  const name = names[0];
  if (!name) throw new Error(`[wake-word] ONNX graph has no ${what} tensor`);
  return name;
}

/**
 * Streaming wake-word detector. Feed frames; `onWake` fires once per
 * detected utterance (refractory-debounced). The voice loop wires `onWake`
 * to "start a listening window" — exactly what a push-to-talk press does.
 *
 * Only constructed in `local` mode. `cloud` mode never instantiates this
 * (and `resolveWakeWordModel` is never called there), so the surface is
 * inert per the hide-not-disable rule.
 */
export class OpenWakeWordDetector {
  private readonly model: WakeWordModel;
  private readonly cfg: Required<WakeWordConfig>;
  private cooldown = 0;
  private readonly onWake: () => void;

  constructor(args: {
    model: WakeWordModel;
    config?: WakeWordConfig;
    onWake: () => void;
  }) {
    this.model = args.model;
    this.cfg = { ...DEFAULTS, ...(args.config ?? {}) };
    this.onWake = args.onWake;
  }

  /**
   * Score one PCM frame; fire `onWake` on a fresh detection. Resolves to
   * true when this frame fired the wake word.
   */
  async pushFrame(frame: Float32Array): Promise<boolean> {
    if (frame.length !== this.model.frameSamples) {
      throw new Error(
        `[wake-word] frame has ${frame.length} samples, expected ${this.model.frameSamples}`,
      );
    }
    if (this.cooldown > 0) {
      this.cooldown--;
      await this.model.scoreFrame(frame); // keep the streaming state warm
      return false;
    }
    const p = await this.model.scoreFrame(frame);
    if (p >= this.cfg.threshold) {
      this.cooldown = this.cfg.refractoryFrames;
      this.onWake();
      return true;
    }
    return false;
  }

  reset(): void {
    this.model.reset();
    this.cooldown = 0;
  }
}

/**
 * Resolve the bundled openWakeWord graphs. Unlike the VAD model this is
 * *optional* — a missing file means "wake word unavailable for this
 * bundle", not "broken bundle". Returns null when any of the three graphs
 * is absent so callers keep voice mode working (push-to-talk / VAD-gated)
 * without it.
 *
 * Search order, per graph:
 *   1. `<bundleRoot>/wake/<name>.onnx`
 *   2. `<state-dir>/local-inference/wake/<name>.onnx` (shared cache)
 * `head` defaults to the bundle's default wake phrase.
 *
 * MUST only be called in `local` mode. The cloud-mode router does not
 * reach this (the wake-word setting is rejected there) — see AGENTS.md §5
 * hide-not-disable.
 */
export function resolveWakeWordModel(opts: {
  bundleRoot?: string;
  head?: string;
}): WakeWordModelPaths | null {
  const headName = opts.head?.trim() || OPENWAKEWORD_DEFAULT_HEAD;
  const headRel = path.join(OPENWAKEWORD_DIR_REL_PATH, `${headName}.onnx`);
  const find = (rel: string): string | null => {
    const candidates: string[] = [];
    if (opts.bundleRoot) candidates.push(path.join(opts.bundleRoot, rel));
    candidates.push(path.join(localInferenceRoot(), rel));
    for (const c of candidates) if (existsSync(c)) return path.resolve(c);
    return null;
  };
  const melspectrogram = find(OPENWAKEWORD_MELSPEC_REL_PATH);
  const embedding = find(OPENWAKEWORD_EMBEDDING_REL_PATH);
  const head = find(headRel);
  if (!melspectrogram || !embedding || !head) return null;
  return { melspectrogram, embedding, head };
}

/**
 * Convenience: resolve the bundled graphs and load an `OpenWakeWordModel`.
 * Returns null when the bundle has no wake-word model (optional asset).
 * Throws `WakeWordUnavailableError` when the model exists but the runtime
 * is missing or a graph is corrupt.
 */
export async function loadBundledWakeWordModel(opts: {
  bundleRoot?: string;
  head?: string;
}): Promise<OpenWakeWordModel | null> {
  const paths = resolveWakeWordModel(opts);
  if (!paths) return null;
  return OpenWakeWordModel.load(paths);
}
