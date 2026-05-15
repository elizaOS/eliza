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
import { loadOnnxRuntime, OnnxRuntimeUnavailableError, } from "./onnx-runtime";
/** Directory holding the bundled openWakeWord ONNX graphs inside a bundle. */
export const OPENWAKEWORD_DIR_REL_PATH = "wake";
/** Shared melspectrogram front-end (one per bundle, model-agnostic). */
export const OPENWAKEWORD_MELSPEC_REL_PATH = path.join(OPENWAKEWORD_DIR_REL_PATH, "melspectrogram.onnx");
/** Shared audio→embedding model (one per bundle, model-agnostic). */
export const OPENWAKEWORD_EMBEDDING_REL_PATH = path.join(OPENWAKEWORD_DIR_REL_PATH, "embedding_model.onnx");
/**
 * Default wake-word head shipped with a voice bundle (the wake phrase).
 * The documented default Eliza-1 wake phrase is **"hey eliza"** — a
 * two-word, four-syllable phrase the openWakeWord TTS-augmented pipeline
 * handles well. It is replaceable: retrain on a different `--phrase` via
 * `packages/training/scripts/wakeword/train_eliza1_wakeword_head.py` and
 * re-point this constant + `WAKEWORD_FILES` in the asset-staging script.
 */
export const OPENWAKEWORD_DEFAULT_HEAD = "hey-eliza";
/** Relative path of the default wake-word head ONNX inside a bundle. */
export const OPENWAKEWORD_DEFAULT_HEAD_REL_PATH = path.join(OPENWAKEWORD_DIR_REL_PATH, `${OPENWAKEWORD_DEFAULT_HEAD}.onnx`);
/**
 * Heads that are placeholders, not a head trained on the Eliza-1 wake
 * phrase.
 *
 * Bundle assets at `wake/hey-eliza.onnx` may come from one of two sources
 * (see `stage_eliza1_bundle_assets.py`):
 *
 *   1. **Trained head** (`--wakeword-head-path` passed to staging): the
 *      ONNX exported by
 *      `packages/training/scripts/wakeword/train_eliza1_wakeword_head.py`
 *      against the "hey eliza" phrase. The first such head (2026-05-14,
 *      TA=90% / FA=10% on a tiny 20+20 synthetic held-out) is staged into
 *      the two local Eliza-1 tier bundles; the per-bundle manifest carries
 *      `files.wake[*].releaseState = "weights-staged"` and `headMetrics`
 *      so consumers can audit the provenance.
 *   2. **Upstream placeholder** (no `--wakeword-head-path`): the staging
 *      script falls back to `hey_jarvis_v0.1.onnx` renamed — that fires on
 *      "hey jarvis", NOT "hey eliza".
 *
 * `hey-eliza` stays in this set for now because the runtime cannot
 * distinguish case 1 from case 2 by inspecting the head ONNX alone, and
 * not all bundles will be re-staged with the trained head immediately.
 * A future pass should teach the engine to consult the manifest's
 * `releaseState` (so trained heads suppress the placeholder warning) and
 * then remove `hey-eliza` from this set. `hey_jarvis` stays by definition
 * — it is the wrong phrase.
 */
export const OPENWAKEWORD_PLACEHOLDER_HEADS = new Set([
    "hey-eliza",
    "hey_jarvis",
]);
export function isPlaceholderWakeWordHead(head) {
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
const DEFAULTS = {
    threshold: 0.5,
    refractoryFrames: 25, // ~2 s @ 80 ms frames
};
/** Thrown when the openWakeWord backend cannot be loaded — missing
 *  `onnxruntime-node` or a corrupt graph. NOT thrown for an absent
 *  bundled model (that is "wake word unavailable for this bundle", not a
 *  broken bundle — `resolveWakeWordModel` returns null instead). */
export class WakeWordUnavailableError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "WakeWordUnavailableError";
        this.code = code;
    }
}
async function loadOrt() {
    try {
        return await loadOnnxRuntime();
    }
    catch (err) {
        if (err instanceof OnnxRuntimeUnavailableError) {
            throw new WakeWordUnavailableError("ort-missing", `${err.message} Install it to enable on-device wake-word detection; push-to-talk and VAD-gated listening keep working without it.`);
        }
        throw err;
    }
}
/**
 * The real openWakeWord streaming detector. Owns three `InferenceSession`s
 * (melspec / embedding / head), a carried-over audio tail, a mel-frame ring
 * and an embedding ring. `scoreFrame` consumes exactly `frameSamples`
 * (1280) samples at 16 kHz and returns the most recent head probability.
 */
export class OpenWakeWordModel {
    melspec;
    embedding;
    head;
    Tensor;
    melInputName;
    melOutputName;
    embeddingInputName;
    embeddingOutputName;
    headInputName;
    headOutputName;
    frameSamples = FRAME_SAMPLES;
    sampleRate = 16_000;
    audioTail = new Float32Array(MEL_LEAD_IN_SAMPLES);
    melRing = [];
    framesSinceEmbedding = 0;
    embeddingRing = [];
    lastProbability = 0;
    constructor(melspec, embedding, head, Tensor, melInputName, melOutputName, embeddingInputName, embeddingOutputName, headInputName, headOutputName) {
        this.melspec = melspec;
        this.embedding = embedding;
        this.head = head;
        this.Tensor = Tensor;
        this.melInputName = melInputName;
        this.melOutputName = melOutputName;
        this.embeddingInputName = embeddingInputName;
        this.embeddingOutputName = embeddingOutputName;
        this.headInputName = headInputName;
        this.headOutputName = headOutputName;
    }
    /**
     * Load a wake-word model from its three ONNX graphs. Throws
     * `WakeWordUnavailableError` when `onnxruntime-node` is missing or a
     * graph fails to load.
     */
    static async load(paths) {
        const ort = await loadOrt();
        let melspec;
        let embedding;
        let head;
        try {
            [melspec, embedding, head] = await Promise.all([
                ort.InferenceSession.create(paths.melspectrogram),
                ort.InferenceSession.create(paths.embedding),
                ort.InferenceSession.create(paths.head),
            ]);
        }
        catch (err) {
            throw new WakeWordUnavailableError("model-load-failed", `[wake-word] failed to load openWakeWord graphs (${paths.melspectrogram} / ${paths.embedding} / ${paths.head}): ${err instanceof Error ? err.message : String(err)}`);
        }
        return new OpenWakeWordModel(melspec, embedding, head, ort.Tensor, requireName(melspec.inputNames, "melspectrogram input"), requireName(melspec.outputNames, "melspectrogram output"), requireName(embedding.inputNames, "embedding input"), requireName(embedding.outputNames, "embedding output"), requireName(head.inputNames, "wake-word head input"), requireName(head.outputNames, "wake-word head output"));
    }
    reset() {
        this.audioTail = new Float32Array(MEL_LEAD_IN_SAMPLES);
        this.melRing = [];
        this.framesSinceEmbedding = 0;
        this.embeddingRing = [];
        this.lastProbability = 0;
    }
    async scoreFrame(frame) {
        if (frame.length !== FRAME_SAMPLES) {
            throw new Error(`[wake-word] OpenWakeWordModel.scoreFrame expects ${FRAME_SAMPLES} samples; got ${frame.length}`);
        }
        await this.ingestMelFrames(frame);
        const embeddingsToRun = this.drainEmbeddingWindows();
        for (const window of embeddingsToRun) {
            await this.appendEmbedding(window);
            await this.runHeadIfReady();
        }
        return this.lastProbability;
    }
    async ingestMelFrames(chunk) {
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
            throw new Error(`[wake-word] melspectrogram produced ${bins} mel bins; expected ${MEL_BINS}`);
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
            this.melRing = this.melRing.slice(this.melRing.length - MEL_RING_CAP_FRAMES);
        }
    }
    /** Pull every embedding window that is due (76-frame window, 8-frame hop). */
    drainEmbeddingWindows() {
        const windows = [];
        while (this.melRing.length >= EMBEDDING_WINDOW_FRAMES &&
            this.framesSinceEmbedding >= EMBEDDING_HOP_FRAMES) {
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
    async appendEmbedding(melWindow) {
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
            throw new Error(`[wake-word] embedding model produced ${tensor.data.length} values; expected >= ${EMBEDDING_DIM}`);
        }
        this.embeddingRing.push(tensor.data.slice(0, EMBEDDING_DIM));
        if (this.embeddingRing.length > EMBEDDING_RING_CAP) {
            this.embeddingRing = this.embeddingRing.slice(this.embeddingRing.length - EMBEDDING_RING_CAP);
        }
    }
    async runHeadIfReady() {
        if (this.embeddingRing.length < HEAD_WINDOW_EMBEDDINGS)
            return;
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
function requireName(names, what) {
    const name = names[0];
    if (!name)
        throw new Error(`[wake-word] ONNX graph has no ${what} tensor`);
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
    model;
    cfg;
    cooldown = 0;
    onWake;
    constructor(args) {
        this.model = args.model;
        this.cfg = { ...DEFAULTS, ...(args.config ?? {}) };
        this.onWake = args.onWake;
    }
    /**
     * Score one PCM frame; fire `onWake` on a fresh detection. Resolves to
     * true when this frame fired the wake word.
     */
    async pushFrame(frame) {
        if (frame.length !== this.model.frameSamples) {
            throw new Error(`[wake-word] frame has ${frame.length} samples, expected ${this.model.frameSamples}`);
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
    reset() {
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
export function resolveWakeWordModel(opts) {
    const headName = opts.head?.trim() || OPENWAKEWORD_DEFAULT_HEAD;
    const headRel = path.join(OPENWAKEWORD_DIR_REL_PATH, `${headName}.onnx`);
    const find = (rel) => {
        const candidates = [];
        if (opts.bundleRoot)
            candidates.push(path.join(opts.bundleRoot, rel));
        candidates.push(path.join(localInferenceRoot(), rel));
        for (const c of candidates)
            if (existsSync(c))
                return path.resolve(c);
        return null;
    };
    const melspectrogram = find(OPENWAKEWORD_MELSPEC_REL_PATH);
    const embedding = find(OPENWAKEWORD_EMBEDDING_REL_PATH);
    const head = find(headRel);
    if (!melspectrogram || !embedding || !head)
        return null;
    return { melspectrogram, embedding, head };
}
/**
 * Convenience: resolve the bundled graphs and load an `OpenWakeWordModel`.
 * Returns null when the bundle has no wake-word model (optional asset).
 * Throws `WakeWordUnavailableError` when the model exists but the runtime
 * is missing or a graph is corrupt.
 */
export async function loadBundledWakeWordModel(opts) {
    const paths = resolveWakeWordModel(opts);
    if (!paths)
        return null;
    return OpenWakeWordModel.load(paths);
}
//# sourceMappingURL=wake-word.js.map