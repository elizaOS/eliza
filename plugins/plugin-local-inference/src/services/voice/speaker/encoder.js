/**
 * WeSpeaker ResNet34-LM ONNX speaker-embedding encoder.
 *
 * Produces a 256-dim L2-normalized speaker embedding from a mono PCM
 * waveform sampled at 16 kHz. The model is the upstream
 * `Wespeaker/wespeaker-voxceleb-resnet34-LM` int8 ONNX export
 * (~7 MB on disk; CC-BY-4.0 — attribution required in the manifest).
 *
 * The encoder is intentionally stateless: callers pass an audio
 * window, get back a single centroid-friendly embedding. Frame-level
 * statistics pooling happens inside the model graph itself; we feed
 * the entire window in one shot. For long captures the recommended
 * pattern is 3-second sliding windows averaged in caller code (the
 * profile store does this when finalizing an owner capture).
 *
 * The dependency on `onnxruntime-node` is *optional* — `loadOnnxRuntime`
 * raises a structured error if the dep is missing. The voice pipeline
 * surfaces that as "speaker recognition unavailable" without crashing
 * the rest of the runtime. There is no synthetic fallback (synthetic
 * embeddings would silently match every voice to whatever cluster they
 * happened to be near in the synthetic feature space — see
 * `voice-profile-artifact.ts` for the historical synthetic-feature
 * path; that file is now consent / hashing only and does NOT feed
 * matching).
 */
import { loadOnnxRuntime, OnnxRuntimeUnavailableError, } from "../onnx-runtime";
import { normalizeVoiceEmbedding } from "../speaker-imprint";
/** Canonical model id stored on every `VoiceProfileRecord.embeddingModel`. */
export const WESPEAKER_RESNET34_LM_INT8_MODEL_ID = "wespeaker-resnet34-lm-int8";
export const WESPEAKER_RESNET34_LM_FP32_MODEL_ID = "wespeaker-resnet34-lm-fp32";
/** Output embedding dim of the ResNet34-LM checkpoint. */
export const WESPEAKER_EMBEDDING_DIM = 256;
/** Required input sample rate (matches the WeSpeaker training config). */
export const WESPEAKER_SAMPLE_RATE = 16_000;
/** Minimum useful audio window for an embedding (~1.0 s).
 *  Shorter windows yield embeddings dominated by the silence-padding
 *  bias and are not safe to fold into a centroid. */
export const WESPEAKER_MIN_SAMPLES = 16_000;
/** Thrown when the encoder cannot be constructed (missing ORT, bad graph). */
export class SpeakerEncoderUnavailableError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "SpeakerEncoderUnavailableError";
        this.code = code;
    }
}
async function loadOrt() {
    try {
        return await loadOnnxRuntime();
    }
    catch (err) {
        if (err instanceof OnnxRuntimeUnavailableError) {
            throw new SpeakerEncoderUnavailableError("ort-missing", `${err.message} Install it to enable on-device speaker recognition; the pipeline runs without speaker-ID until then.`);
        }
        throw err;
    }
}
function pickInputName(session) {
    const name = session.inputNames[0];
    if (!name) {
        throw new SpeakerEncoderUnavailableError("model-load-failed", "[wespeaker] ONNX session has no input bindings");
    }
    return name;
}
function pickOutputName(session) {
    const name = session.outputNames[0];
    if (!name) {
        throw new SpeakerEncoderUnavailableError("model-load-failed", "[wespeaker] ONNX session has no output bindings");
    }
    return name;
}
/**
 * WeSpeaker ResNet34-LM ONNX implementation. Honors the
 * `[batch=1, time]` raw-PCM input convention used by the upstream
 * export. Releases the session via `dispose()`.
 */
export class WespeakerEncoder {
    session;
    Tensor;
    inputName;
    outputName;
    modelId;
    embeddingDim = WESPEAKER_EMBEDDING_DIM;
    sampleRate = WESPEAKER_SAMPLE_RATE;
    disposed = false;
    constructor(session, Tensor, inputName, outputName, modelId) {
        this.session = session;
        this.Tensor = Tensor;
        this.inputName = inputName;
        this.outputName = outputName;
        this.modelId = modelId;
    }
    static async load(modelPath, modelId = WESPEAKER_RESNET34_LM_INT8_MODEL_ID) {
        const ort = await loadOrt();
        let session;
        try {
            session = await ort.InferenceSession.create(modelPath);
        }
        catch (err) {
            throw new SpeakerEncoderUnavailableError("model-load-failed", `[wespeaker] failed to load encoder from ${modelPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
        return new WespeakerEncoder(session, ort.Tensor, pickInputName(session), pickOutputName(session), modelId);
    }
    async encode(pcm) {
        if (this.disposed) {
            throw new SpeakerEncoderUnavailableError("model-load-failed", "[wespeaker] encoder has been disposed");
        }
        if (pcm.length < WESPEAKER_MIN_SAMPLES) {
            throw new SpeakerEncoderUnavailableError("invalid-input", `[wespeaker] input window too short: ${pcm.length} samples (< ${WESPEAKER_MIN_SAMPLES})`);
        }
        for (let i = 0; i < pcm.length; i += 1) {
            if (!Number.isFinite(pcm[i])) {
                throw new SpeakerEncoderUnavailableError("invalid-input", `[wespeaker] non-finite sample at index ${i}`);
            }
        }
        const input = new this.Tensor("float32", pcm, [1, pcm.length]);
        const out = await this.session.run({ [this.inputName]: input });
        const tensor = out[this.outputName];
        if (!tensor || !(tensor.data instanceof Float32Array)) {
            throw new SpeakerEncoderUnavailableError("model-load-failed", "[wespeaker] encoder did not return a Float32Array embedding");
        }
        // Some upstream exports emit `[1, 256]`, others `[256]`. We
        // L2-normalize defensively so the caller can dot-product directly.
        if (tensor.data.length !== this.embeddingDim) {
            throw new SpeakerEncoderUnavailableError("model-load-failed", `[wespeaker] expected ${this.embeddingDim}-dim embedding, got ${tensor.data.length}`);
        }
        const normalized = normalizeVoiceEmbedding(tensor.data);
        return Float32Array.from(normalized);
    }
    async dispose() {
        this.disposed = true;
        // `OrtInferenceSession.release` exists at runtime on
        // onnxruntime-node but is not in our minimal type contract;
        // best-effort cast for the cleanup.
        const maybe = this.session;
        if (typeof maybe.release === "function") {
            await maybe.release();
        }
    }
}
/**
 * Combine N per-window embeddings into a single L2-normalized centroid.
 * Used by the onboarding finalizer (six 3-second windows → one centroid)
 * and by the running-mean refinement on each new attribution.
 */
export function averageEmbeddings(embeddings) {
    if (embeddings.length === 0) {
        throw new SpeakerEncoderUnavailableError("invalid-input", "[wespeaker] averageEmbeddings called with no inputs");
    }
    const dim = embeddings[0].length;
    const sum = new Float64Array(dim);
    for (const emb of embeddings) {
        if (emb.length !== dim) {
            throw new SpeakerEncoderUnavailableError("invalid-input", `[wespeaker] embedding dim mismatch: ${emb.length} vs ${dim}`);
        }
        for (let i = 0; i < dim; i += 1)
            sum[i] += emb[i];
    }
    const out = new Float32Array(dim);
    for (let i = 0; i < dim; i += 1)
        out[i] = sum[i] / embeddings.length;
    const normalized = normalizeVoiceEmbedding(out);
    return Float32Array.from(normalized);
}
//# sourceMappingURL=encoder.js.map