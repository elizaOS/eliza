/**
 * Local ASR (transcription) types — mirrors the WS2 vision-describe and
 * WS3 image-gen splits.
 *
 * Two layers live here:
 *
 *   1. The **request/result** contract every backend implements
 *      (`AsrRequest`, `AsrResult`). Callers pass mono 16 kHz fp32 PCM (or
 *      a sample rate the backend can resample from), backends return a
 *      transcript string plus optional token / segment metadata.
 *
 *   2. The **backend** interface (`AsrBackend`) the `MemoryArbiter`
 *      (WS1) registers as a capability handler. One backend per
 *      per-platform path:
 *
 *        - `fused`           — `eliza_inference_asr_*` ABI (Qwen3-ASR
 *          inside the fused libelizainference). Linux / macOS / Windows
 *          desktop, AOSP system app via the same fused build.
 *        - `openvino-whisper` — Intel NPU/CPU autoprobe via a Python
 *          worker subprocess (`scripts/openvino-whisper-asr-worker.py`).
 *          Off by default; opt-in tier for Intel Core Ultra hardware.
 *        - `coreml`          — Capacitor bridge to a Core ML Whisper
 *          model on iOS (stub here until the bridge ships).
 *        - `aosp-ffi`        — bun:ffi shim around the AOSP NDK Whisper /
 *          Qwen-ASR JNI handle (stub today; lands when the AOSP fused
 *          ASR symbols are exported).
 *        - `fake`            — deterministic in-process stub used by tests.
 *
 * Cache contract:
 *
 *   The arbiter caches transcript text by **content hash** of the input PCM
 *   (sample-rate-normalized to 16 kHz mono). The cache namespace is
 *   `asr-transcripts` — distinct from the WS2 vision-embedding cache
 *   (`vision-projector-tokens`) and the WS3 image-gen request key space.
 *   Re-transcribing the same audio is a fast text return; the backend
 *   never re-runs.
 */

/** A request the ASR capability handler accepts. */
export interface AsrRequest {
	/**
	 * Mono 32-bit float PCM samples. Range [-1, 1]. The backend will resample
	 * to 16 kHz internally if `sampleRateHz` is not 16000.
	 */
	pcm: Float32Array;
	/** Sample rate of `pcm`, in Hz. Common values: 16000, 24000, 48000. */
	sampleRateHz: number;
	/** Optional caller-supplied abort signal. Backends MUST honour it. */
	signal?: AbortSignal;
	/** Optional model family tag for cache scoping. Defaults to `qwen3-asr`. */
	modelFamily?: string;
	/** Optional BCP-47 language hint (e.g. `"en"`, `"zh"`). Backends may ignore. */
	language?: string;
}

/** Backend response. The arbiter normalizes this back to a plain string for the model handler. */
export interface AsrResult {
	/** Final transcript. Whitespace-trimmed. Never undefined; empty string is a real "no speech detected" result. */
	text: string;
	/** Optional per-segment timings. Backends that support diarization emit one segment per speaker turn. */
	segments?: ReadonlyArray<{
		text: string;
		startMs: number;
		endMs: number;
		speaker?: string;
	}>;
	/** Optional Qwen2-BPE token ids — the fused build emits these so STT-finish token injection skips re-tokenization. */
	tokens?: ReadonlyArray<number>;
	/** Optional inference time in ms (wall clock, not GPU compute). */
	inferenceTimeMs?: number;
	/** True when the response came from the arbiter's content-hash cache. */
	cacheHit?: boolean;
}

/** Arguments the arbiter passes to the loader. */
export interface AsrLoadArgs {
	modelKey: string;
}

/** Backend contract. Every per-platform ASR runtime implements this. */
export interface AsrBackend {
	/** Stable identifier for telemetry / errors (`"fused"`, `"openvino-whisper"`, `"coreml"`, ...). */
	readonly id: string;
	/**
	 * Whether this backend supports the request as-is. False → the arbiter
	 * throws `AsrBackendUnavailableError` with `unsupported_request`. Most
	 * backends return `true` for any non-empty PCM ≤ a hard length cap.
	 */
	supports(req: AsrRequest): boolean;
	/** Run a transcription. The backend MUST honour `req.signal`. */
	transcribe(req: AsrRequest): Promise<AsrResult>;
	/** Release native resources held by this backend handle. */
	dispose(): Promise<void>;
}

/** Async loader the registration takes — invoked by the arbiter on first use of a given modelKey. */
export type AsrBackendLoader = (modelKey: string) => Promise<AsrBackend>;
