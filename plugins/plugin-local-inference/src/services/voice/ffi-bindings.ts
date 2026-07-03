/**
 * Node/Bun FFI binding to `libelizainference.{dylib,so,dll}`.
 *
 * The fused omnivoice + llama.cpp build (see
 * `packages/app-core/scripts/omnivoice-fuse/`) produces ONE shared
 * library that exports both `llama_*` and `omnivoice_*` symbols plus
 * the C ABI declared in `scripts/omnivoice-fuse/ffi.h`. This module is
 * the JS-side proxy for that ABI — it loads the library, binds every
 * `eliza_inference_*` symbol declared in `ffi.h`, and exposes a typed
 * handle (`ElizaInferenceFfi`) the voice lifecycle calls into.
 *
 * Runtime: production runs under Bun (Electrobun shell, Capacitor
 * bridge), so the loader uses `bun:ffi`. Tests that need to actually
 * load a `.dylib` against a stub library spawn a `bun` subprocess —
 * see `ffi-bindings.test.ts`. Calling this loader from a non-Bun
 * runtime (e.g. plain Node) throws `VoiceLifecycleError({code:
 * "missing-ffi"})` with a diagnostic explaining why.
 *
 * No defensive try/catch on the success path. Any dlopen failure,
 * symbol-resolution failure, or ABI mismatch is a structured throw
 * (AGENTS.md §3 + §9). The caller — `voice/lifecycle.ts` and
 * `voice/engine-bridge.ts` — surfaces it as a `VoiceLifecycleError` to
 * the UI.
 */

import path from "node:path";

import { VoiceLifecycleError } from "./lifecycle";

/**
 * Make a directory discoverable by the Win32 DLL loader for this process by
 * prepending it to PATH (step 6 of the standard DLL search order).
 *
 * The fused lib's sibling backends (`ggml*.dll`, `llama*.dll`, `mtmd.dll`) are
 * staged NEXT TO `elizainference.dll`, but when a DLL is opened by absolute
 * path the Win32 loader does NOT search that DLL's own directory for its
 * dependencies — it searches the host EXE's dir, the system dirs, and PATH. So
 * `dlopen` fails with "error code 126" (a dependent DLL could not be found)
 * even though the siblings are right there. Linux/macOS don't need this:
 * `stage-desktop-fused-lib.mjs` bakes a relative rpath (`$ORIGIN` /
 * `@loader_path`) at link time so the loader resolves siblings from the lib's
 * own dir. Idempotent; a no-op off win32 and when `dir` is already on PATH.
 */
function ensureWin32DllSearchDir(dir: string): void {
	if (process.platform !== "win32" || !dir) return;
	const current = process.env.PATH ?? "";
	const resolved = path.resolve(dir);
	const already = current
		.split(path.delimiter)
		.some((seg) => seg && path.resolve(seg) === resolved);
	if (already) return;
	process.env.PATH = current
		? `${resolved}${path.delimiter}${current}`
		: resolved;
}

/**
 * ABI version the JS binding was authored against. Must match the value
 * `eliza_inference_abi_version()` returns at runtime — a mismatch is a
 * hard error (AGENTS.md §3, §9: no silent compatibility shims).
 *
 * Bump in lockstep with `ELIZA_INFERENCE_ABI_VERSION` in
 * `scripts/omnivoice-fuse/ffi.h` whenever the C surface changes shape.
 *
 * v4: the FFI bridge resolves `speaker_preset_id` against the bundle's
 *     `cache/voice-preset-<id>.bin` (ELZ2 v2) and applies the
 *     `(instruct, ref_audio_tokens, ref_T, ref_text)` triple to
 *     `ov_tts_params` before calling `ov_synthesize`. Adds the
 *     `eliza_inference_encode_reference` entrypoint that the freeze CLI
 *     uses to pre-encode reference WAVs into the preset file. A v3 caller
 *     remains source-compatible: every v3 entry point keeps its v3 shape.
 *
 * v5: the FFI bridge gains the native openWakeWord surface
 *     (`eliza_inference_wakeword_supported/open/score/reset/close`). It
 *     replaces the previous `onnxruntime-node`-backed wake-word path —
 *     the JS binding routes wake-word detection exclusively through this
 *     ABI with no ONNX fallback (AGENTS.md §3, §8). v4 callers that
 *     never touched the wake-word entries are source-compatible.
 *
 * v6: the FFI bridge gains the native speaker-encoder + diarizer
 *     surfaces (`eliza_inference_speaker_supported/open/embed/free/close`
 *     and `eliza_inference_diariz_supported/open/segment/close`). These
 *     fuse the remaining standalone `libvoice_classifier` voice
 *     classifiers into the one `libelizainference` handle so the whole
 *     voice pipeline runs through a single native lib. v5 callers that
 *     never touched the speaker/diarizer entries are source-compatible.
 *
 * v9: the last text-adjacent modalities move onto the fused handle. Three
 *     additive surfaces + probes: text embeddings (`embed` / `embedSupported`),
 *     mmproj vision describe (`describeImage` / `visionSupported`), and the
 *     tokenizer (`tokenize` / `detokenize` / `tokenizeSupported`). With these,
 *     libllama is fully retired: text, embeddings, vision, and tokenization all
 *     run through the fused handle. A pre-v9 library lacks these symbols, so the
 *     probes report unsupported and the fused runtime refuses (there is no
 *     libllama fallback). v8 callers that never touched the new entries remain
 *     source-compatible (the new probes simply return false on a v8 lib).
 *
 * v10: Kokoro-82M TTS folded in-process. The fused handle gains
 *     `eliza_inference_kokoro_supported/load/synthesize/sample_rate` so the
 *     mobile Kokoro path synthesizes through the same dlopen()-ed
 *     libelizainference as OmniVoice instead of POSTing to the local-TCP
 *     `llama-server /v1/audio/speech` route (forbidden on iOS / Google Play).
 *     The four symbols are additive — a v9 library lacks them, so the
 *     `kokoroSupported()` probe reports false and the Kokoro FFI runtime
 *     refuses (no TCP fallback on mobile). A v9 library is still accepted at
 *     degraded capability: its voice/ASR/VAD/LLM/text surface is unchanged and
 *     Kokoro just probes unsupported on it.
 *
 * v14: Kokoro IPA input + G2P-kind capability query. The fused handle gains
 *     `eliza_inference_kokoro_g2p_kind` (does the linked kokoro_lib phonemize
 *     raw text with real espeak-ng, or only the lossy ASCII grapheme fallback?)
 *     and `eliza_inference_kokoro_synthesize_ipa` (synthesize from precomputed
 *     espeak-ng IPA, bypassing the in-lib phonemizer). On an espeak-less build
 *     (Android / iOS / host without libespeak-ng) the raw-text path is
 *     unintelligible; the Kokoro runtime queries g2p_kind and, when ASCII, feeds
 *     the espeak-ng-WASM IPA it already computed through the IPA entry (#11776).
 *     The two symbols are additive — a v13 library lacks them, so the g2p-kind
 *     query reports "unknown" and the runtime keeps the raw-text path (with a
 *     loud one-time warning naming the fix). NOTE: v13 (token-by-token vision
 *     describe) is the main-lineage vision surface; the develop-pinned fork
 *     lineage advances 12 -> 14 for the Kokoro IPA surface (fork-sync #11386)
 *     so the two independent bumps stay collision-free.
 */
export const ELIZA_INFERENCE_ABI_VERSION = 14 as const;

/** One transcribed word with playback-synced timing (ms from utterance start). */
export interface AsrWordTiming {
	text: string;
	startMs: number;
	endMs: number;
}

/**
 * Recover per-word `{ text, startMs, endMs }` from a v12 timed-ASR result.
 *
 * The native `eliza_inference_asr_transcribe_timed` sizes the `startMs`/`endMs`
 * arrays by splitting the transcript on ASCII whitespace — `std::isspace` in the
 * C locale matches EXACTLY ` \t\n\v\f\r`. We must mirror that split byte-for-byte
 * to recover the word strings: a broader Unicode `\s` split collapses NBSP /
 * ideographic space (U+00A0, U+3000, …) that the native byte split keeps, which
 * would make `tokens` shorter than `count` and silently zip each word's text
 * against a DIFFERENT word's timing — a desync `validateAsrWordTimings` cannot
 * see (it never compares text to count). `count` only falls below the true word
 * count when the caller's `maxWords` cap is hit, in which case the trailing
 * (untimed) words are dropped by `Math.min`.
 */
export function recoverAsrWords(
	text: string,
	count: number,
	startMs: Int32Array,
	endMs: Int32Array,
): AsrWordTiming[] {
	const tokens = text.split(/[ \t\n\v\f\r]+/).filter(Boolean);
	const n = Math.min(count, tokens.length);
	const words: AsrWordTiming[] = [];
	for (let i = 0; i < n; i++) {
		words.push({
			text: tokens[i] as string,
			startMs: startMs[i] ?? 0,
			endMs: endMs[i] ?? 0,
		});
	}
	return words;
}

/**
 * Pooling strategies for `embed`. Mirror `enum llama_pooling_type` and the
 * `ELIZA_POOLING_*` constants in `eliza-inference-ffi.h`.
 */
export const ELIZA_POOLING_MEAN = 1;
export const ELIZA_POOLING_CLS = 2;
export const ELIZA_POOLING_LAST = 3;

/** Status codes mirrored from `ffi.h`. Negative = failure. */
export const ELIZA_OK = 0;
export const ELIZA_ERR_NOT_IMPLEMENTED = -1;
export const ELIZA_ERR_INVALID_ARG = -2;
export const ELIZA_ERR_BUNDLE_INVALID = -3;
export const ELIZA_ERR_FFI_FAULT = -4;
export const ELIZA_ERR_OOM = -5;
export const ELIZA_ERR_ABI_MISMATCH = -6;
export const ELIZA_ERR_CANCELLED = -7;

/**
 * Kokoro G2P kind (ABI v14). Mirrors `ELIZA_KOKORO_G2P_*` in
 * `eliza-inference-ffi.h`: `eliza_inference_kokoro_g2p_kind` returns ESPEAK when
 * the fused build links libespeak-ng (raw text is phonemized correctly in the
 * lib) and ASCII when it only has the lossy grapheme fallback (the TS layer must
 * supply espeak-ng IPA via `synthesize_ipa`).
 */
export const ELIZA_KOKORO_G2P_ASCII = 0;
export const ELIZA_KOKORO_G2P_ESPEAK = 1;

/**
 * WeSpeaker ResNet34-LM embedding dimension. The native
 * `eliza_inference_speaker_embed` writes exactly this many L2-normalized
 * fp32 values into the caller-owned output buffer. Mirrors the C-side
 * `VOICE_SPEAKER_EMBEDDING_DIM` and `SPEAKER_GGML_EMBEDDING_DIM`.
 */
const SPEAKER_EMBEDDING_DIM = 256;

/**
 * Upper bound on the per-window diarizer label count. pyannote-3 emits 293
 * int8 frame labels per 5 s window; the caller passes a generous capacity and
 * the library reports the real count back via `*io_n_labels`.
 */
const DIARIZ_LABELS_CAPACITY = 2048;

/**
 * Region names the lifecycle hands to `mmap_acquire` / `mmap_evict`.
 * Mirrors the set the C stub validates in `ffi-stub.c::valid_region`.
 */
export type ElizaInferenceRegion =
	| "tts"
	| "asr"
	| "text"
	| "mtp"
	| "vad"
	| "wakeword";

/**
 * Opaque pointer to the C-side `EliInferenceContext`. Numeric on Bun
 * (FFI returns the raw pointer as `bigint`); never inspected on the JS
 * side beyond passing it back through the binding.
 */
export type ElizaInferenceContextHandle = bigint;

/** Opaque pointer to a native Silero VAD session. */
export type NativeVadHandle = bigint;

/** Opaque pointer to a native openWakeWord session. */
export type NativeWakeWordHandle = bigint;

/** Opaque pointer to a native WeSpeaker speaker-encoder session. */
export type NativeSpeakerHandle = bigint;

/** Opaque pointer to a native pyannote diarizer session. */
export type NativeDiarizHandle = bigint;

/** Opaque pointer to a streaming-LLM session. */
export type LlmStreamHandle = bigint;

/**
 * Per-session config handed to `llmStreamOpen`. Mirrors
 * `eliza_llm_stream_config_t` in
 * `native/llama.cpp/tools/omnivoice/include/eliza-inference-ffi.h` (ABI v9).
 */
export interface LlmStreamConfig {
	maxTokens: number;
	temperature: number;
	topP: number;
	topK: number;
	repeatPenalty: number;
	/** Pinned slot id; -1 disables pinning. */
	slotId: number;
	/** Optional prompt cache key used to derive a slot when `slotId === -1`. */
	promptCacheKey: string | null;
	/** MTP drafter bounds; `0` for either disables speculative decoding. */
	draftMin: number;
	draftMax: number;
	/** Absolute MTP drafter GGUF path; null disables drafter-backed MTP. */
	draftModelPath: string | null;
	/**
	 * GBNF grammar source. When set the native session installs a grammar
	 * sampler FIRST in the chain so every sampled token is constrained — this
	 * is how the structured-reply envelope is forced on the in-process FFI
	 * path. `null`/empty disables grammar constraint.
	 */
	gbnfGrammar?: string | null;
	/** Thinking-tag suppression passthrough (v1 no-op). */
	disableThinking?: boolean;
	/**
	 * Per-load GPU offload (ABI v8). Number of model layers to place on GPU.
	 * `undefined`/-1 selects the runtime default (all layers); 0 forces CPU.
	 * The model is loaded once per ctx, so the FIRST session's value wins.
	 */
	gpuLayers?: number;
	/**
	 * KV-cache K quant type name (ABI v8), e.g. "f16", "q8_0", "qjl1_256".
	 * `undefined`/null leaves the f16 default. Mapped to `ggml_type` by the
	 * fused lib's `eliza_llm_stream_config_t.cache_type_k`.
	 */
	cacheTypeK?: string | null;
	/** KV-cache V quant type name (ABI v8); see `cacheTypeK`. */
	cacheTypeV?: string | null;
	/** Runtime context window in tokens (ABI v9). `undefined`/0 uses native fallback. */
	contextSize?: number;
}

/**
 * One step of streaming LLM output. `tokens` is the batch of accepted text
 * model token ids the runtime committed this step (>= 1; > 1 only when the
 * MTP drafter is active and the verifier accepted multiple drafts).
 * `text` is the detokenized text for those tokens. `done` is `true` only
 * on the final step (EOS reached). `drafterDrafted` and `drafterAccepted`
 * are populated when the drafter is active.
 */
export interface LlmStreamStep {
	tokens: number[];
	text: string;
	done: boolean;
	drafterDrafted: number;
	drafterAccepted: number;
}

/**
 * One streaming-TTS chunk delivered to the `onChunk` callback passed to
 * `ttsSynthesizeStream`. `pcm` is a *view* over the library's buffer —
 * valid only for the duration of the callback; copy it before
 * returning. `isFinal` marks the zero-length tail chunk that closes the
 * utterance. The callback returning `true` requests cancellation at the
 * next kernel boundary.
 */
export interface TtsStreamChunk {
	pcm: Float32Array;
	isFinal: boolean;
}

/**
 * A native MTP speculative-step event from
 * `eliza_inference_set_verifier_callback`. Token-index domain is the
 * generated-output stream (token 0 = first generated token), matching
 * `RejectedTokenRange`. `rejectedFrom`/`rejectedTo` are -1 when nothing
 * was rejected this step.
 */
export interface NativeVerifierEvent {
	acceptedTokenIds: number[];
	rejectedFrom: number;
	rejectedTo: number;
	correctedTokenIds: number[];
}

/**
 * Typed handle returned by `loadElizaInferenceFfi`. Each method maps
 * 1:1 to a symbol declared in `ffi.h`. Methods that allocate a context
 * return the opaque pointer; methods that consume one take it as the
 * first argument. Failures throw `VoiceLifecycleError` with the
 * structured code derived from the C return value.
 */
export interface ElizaInferenceFfi {
	/** Library path the binding was loaded from (for diagnostics). */
	readonly libraryPath: string;
	/** ABI version reported by the loaded library. */
	readonly libraryAbiVersion: string;
	/** Create a fresh context anchored at `bundleDir`. */
	create(bundleDir: string): ElizaInferenceContextHandle;
	/** Destroy a previously-created context. Idempotent on already-freed handles. */
	destroy(ctx: ElizaInferenceContextHandle): void;
	/** Map / re-page weights for a region. */
	mmapAcquire(
		ctx: ElizaInferenceContextHandle,
		region: ElizaInferenceRegion,
	): void;
	/**
	 * Release or evict a voice-only region after the lifecycle leaves
	 * voice-on. Implementations may madvise mapped pages or unload the
	 * ASR/TTS runtime state entirely; callers must treat the region as
	 * unavailable until the next `mmapAcquire`.
	 */
	mmapEvict(
		ctx: ElizaInferenceContextHandle,
		region: ElizaInferenceRegion,
	): void;
	/**
	 * Synchronous TTS forward. Caller provides the output buffer; library
	 * fills up to its capacity and returns the number of samples written.
	 */
	ttsSynthesize(args: {
		ctx: ElizaInferenceContextHandle;
		text: string;
		speakerPresetId: string | null;
		out: Float32Array;
	}): number;
	/**
	 * Synchronous ASR forward. Returns the decoded transcript as a UTF-8
	 * string (allocated by the JS side, sized to fit the library's max
	 * write).
	 */
	asrTranscribe(args: {
		ctx: ElizaInferenceContextHandle;
		pcm: Float32Array;
		sampleRateHz: number;
		maxTextBytes?: number;
	}): string;

	/* ---- ASR word timestamps (ABI v12) --------------------------- */

	/** True when this build can emit per-word ASR timestamps (v12+). v11 and
	 *  older report false — callers fall back to the text-only `asrTranscribe`. */
	timedAsrSupported(): boolean;
	/** Transcribe like `asrTranscribe` AND return per-word `[startMs,endMs)`
	 *  spans (duration-proportional, char-weighted, monotonic — the honest
	 *  single-model signal; see the v12 ABI changelog). The word texts come from
	 *  a whitespace split of the transcript, zipped with the native timing. */
	asrTranscribeTimed(args: {
		ctx: ElizaInferenceContextHandle;
		pcm: Float32Array;
		sampleRateHz: number;
		maxTextBytes?: number;
		maxWords?: number;
	}): { text: string; words: AsrWordTiming[] };

	/* ---- Streaming TTS + verifier callback (ABI v2) --------------- */

	/**
	 * True when this build implements streaming TTS (false for the stub /
	 * a TTS-disabled build). Callers pick the streaming path vs the batch
	 * `ttsSynthesize` off this flag — no probe-and-catch.
	 */
	ttsStreamSupported(): boolean;
	/**
	 * Chunked synthesis. `onChunk` is invoked for each decoded PCM segment
	 * as it arrives, then once more with `isFinal: true` (zero-length
	 * tail). Returning `true` from `onChunk` requests cancellation; the
	 * call then resolves with `cancelled: true` after the final-chunk
	 * callback. Any negative library return is a thrown `VoiceLifecycleError`.
	 */
	ttsSynthesizeStream(args: {
		ctx: ElizaInferenceContextHandle;
		text: string;
		speakerPresetId: string | null;
		onChunk: (chunk: TtsStreamChunk) => boolean | undefined;
	}): { cancelled: boolean };
	/**
	 * Hard-cancel any in-flight TTS forward pass on `ctx` (started on
	 * another thread by `ttsSynthesize` / `ttsSynthesizeStream`). The
	 * in-flight call returns `ELIZA_ERR_CANCELLED` at the next kernel
	 * boundary. Cancelling nothing is not an error.
	 */
	cancelTts(ctx: ElizaInferenceContextHandle): void;
	/**
	 * Register (or, with `cb: null`, clear) the native MTP verifier
	 * callback. The runtime fires `cb` for every speculative accept/reject
	 * step from the in-process drafter↔target loop. The returned
	 * `JSCallbackHandle` MUST be kept alive for as long as the callback is
	 * registered and `.close()`d when it's cleared (or on dispose) — Bun's
	 * `JSCallback` is GC'd otherwise and the native side dereferences a
	 * dead pointer.
	 */
	setVerifierCallback(
		ctx: ElizaInferenceContextHandle,
		cb: ((event: NativeVerifierEvent) => void) | null,
	): { close(): void };

	/* ---- OmniVoice reference encode (ABI v4) ---------------------- */

	/**
	 * True when this build exports the OmniVoice reference-encode symbols
	 * (`eliza_inference_encode_reference`). The freeze CLI uses this to
	 * pre-encode same reference audio into the persisted voice preset;
	 * the runtime synthesis path never calls it (it reads pre-encoded
	 * tokens from the preset file).
	 */
	encodeReferenceSupported?(): boolean;
	/**
	 * Run the encode-only half of the TTS pipeline (HuBERT semantic + RVQ
	 * codec) on a 24 kHz mono fp32 PCM buffer and return the resulting
	 * reference-audio-token tensor `[K=8, ref_T]` as `Int32Array`
	 * row-major (`tokens[k*ref_T + t]`). The library allocates and the
	 * binding takes care of freeing the native buffer via
	 * `eliza_inference_free_tokens` before this returns.
	 *
	 * The TTS region must have been acquired (`mmapAcquire("tts")`)
	 * before the call. `sampleRateHz` must be 24000; the entrypoint does
	 * NOT resample, by design — the freeze artifact must be deterministic.
	 */
	encodeReference?(args: {
		ctx: ElizaInferenceContextHandle;
		pcm: Float32Array;
		sampleRateHz: number;
	}): { K: number; refT: number; tokens: Int32Array };

	/* ---- Native VAD (ABI v3) -------------------------------------- */

	/** True when this build exports and enables the native Silero VAD backend. */
	vadSupported?(): boolean;
	/** Open a native VAD session. The ABI-compatible sample rate is 16 kHz. */
	vadOpen?(args: {
		ctx: ElizaInferenceContextHandle;
		sampleRateHz: number;
	}): NativeVadHandle;
	/** Process one 512-sample fp32 mono window and return P(speech). */
	vadProcess?(args: { vad: NativeVadHandle; pcm: Float32Array }): number;
	/** Clear native VAD recurrent state at utterance boundaries. */
	vadReset?(vad: NativeVadHandle): void;
	/** Close + free a native VAD session. Idempotent on already-closed handles. */
	vadClose?(vad: NativeVadHandle): void;

	/* ---- Native wake-word (ABI v5) -------------------------------- */

	/**
	 * True when this build exports and enables the native openWakeWord
	 * backend. The JS binding routes wake-word detection exclusively
	 * through this surface; when this returns false, the wake-word path
	 * throws a structured "runtime not ready" error — no ONNX fallback
	 * (AGENTS.md §3, §8).
	 */
	wakewordSupported?(): boolean;
	/**
	 * Open a native wake-word session. `sampleRateHz` must be 16000;
	 * `headName` selects the classifier head inside the bundle's combined
	 * wake-word GGUF (e.g. "hey-eliza").
	 */
	wakewordOpen?(args: {
		ctx: ElizaInferenceContextHandle;
		sampleRateHz: number;
		headName: string;
	}): NativeWakeWordHandle;
	/**
	 * Score one 1280-sample (80 ms @ 16 kHz) fp32 mono frame and return
	 * the latest P(wake) in [0, 1]. Early calls before enough context
	 * accumulates return 0.
	 */
	wakewordScore?(args: {
		wake: NativeWakeWordHandle;
		pcm: Float32Array;
	}): number;
	/** Clear all streaming state (audio tail, mel ring, embedding ring). */
	wakewordReset?(wake: NativeWakeWordHandle): void;
	/** Close + free a native wake-word session. Idempotent on already-closed handles. */
	wakewordClose?(wake: NativeWakeWordHandle): void;

	/* ---- Native speaker encoder (ABI v6) -------------------------- */

	/** True when this build exports and enables the native WeSpeaker encoder. */
	speakerSupported?(): boolean;
	/**
	 * Open a native speaker-encoder session. `ggufPath` may be null to
	 * resolve the bundle's `speaker/` dir, or an absolute path to a
	 * WeSpeaker GGUF.
	 */
	speakerOpen?(args: {
		ctx: ElizaInferenceContextHandle;
		ggufPath: string | null;
	}): NativeSpeakerHandle;
	/**
	 * Embed `pcm` (16 kHz mono fp32) into a 256-d L2-normalized speaker
	 * embedding. Returns a freshly-allocated `Float32Array` of length 256.
	 */
	speakerEmbed?(args: {
		speaker: NativeSpeakerHandle;
		pcm: Float32Array;
	}): Float32Array;
	/** Close + free a native speaker-encoder session. Idempotent on already-closed handles. */
	speakerClose?(speaker: NativeSpeakerHandle): void;

	/* ---- Native diarizer (ABI v6) --------------------------------- */

	/** True when this build exports and enables the native pyannote diarizer. */
	diarizSupported?(): boolean;
	/**
	 * Open a native diarizer session. `ggufPath` may be null to resolve the
	 * bundle's `diariz/` dir, or an absolute path to a pyannote GGUF.
	 */
	diarizOpen?(args: {
		ctx: ElizaInferenceContextHandle;
		ggufPath: string | null;
	}): NativeDiarizHandle;
	/**
	 * Segment one 80000-sample (5 s @ 16 kHz) mono fp32 window into a
	 * per-frame powerset-label sequence. Returns the `Int8Array` of frame
	 * labels (293 for pyannote-segmentation-3.0), each in `[0, 7)`.
	 */
	diarizSegment?(args: {
		diariz: NativeDiarizHandle;
		pcm: Float32Array;
	}): Int8Array;
	/** Close + free a native diarizer session. Idempotent on already-closed handles. */
	diarizClose?(diariz: NativeDiarizHandle): void;

	/* ---- Streaming ASR (ABI v2) ----------------------------------- */

	/**
	 * True when this build has a working streaming ASR decoder (false for
	 * the stub / an ASR-disabled build). Callers pick the fused streaming
	 * path vs the fused batch interim adapter off this flag — they do not
	 * have to open a session and catch `ELIZA_ERR_NOT_IMPLEMENTED`.
	 */
	asrStreamSupported(): boolean;
	/** Open a streaming ASR session. The handle is closed via `asrStreamClose`. */
	asrStreamOpen(args: {
		ctx: ElizaInferenceContextHandle;
		sampleRateHz: number;
	}): bigint;
	/** Feed one PCM frame at the session's sample rate. */
	asrStreamFeed(args: { stream: bigint; pcm: Float32Array }): void;
	/** Read the current running partial transcript (and token ids when available). */
	asrStreamPartial(args: {
		stream: bigint;
		maxTextBytes?: number;
		maxTokens?: number;
	}): { partial: string; tokens?: number[] };
	/** Force-finalize: drain buffered audio, run a final decode, return the final transcript. */
	asrStreamFinish(args: {
		stream: bigint;
		maxTextBytes?: number;
		maxTokens?: number;
	}): { partial: string; tokens?: number[] };
	/** Close + free a streaming ASR session. Idempotent on already-closed handles. */
	asrStreamClose(stream: bigint): void;

	/* ---- Streaming LLM (additive on top of ABI v3) ---------------- */

	/**
	 * True when this build exports the streaming LLM symbols
	 * (`eliza_inference_llm_stream_*`). Transitional builds may load
	 * without them; the runner uses this to pick between the FFI streaming
	 * path.
	 */
	llmStreamSupported?(): boolean;
	/**
	 * True when this build wires same-file / separate-drafter MTP
	 * speculative decoding into the streaming-LLM text path (ABI v8). A v7
	 * library returns `false` here (the symbol is absent), so the fused TEXT
	 * path can refuse to route through it without a speculative-decode
	 * regression. Anti-regression guard — see ABI v8 changelog.
	 */
	llmMtpSupported?(): boolean;
	/**
	 * True when this build maps + applies KV-cache quant types in the
	 * streaming-LLM text path (ABI v8). A v7 library returns `false` (symbol
	 * absent); the fused TEXT path refuses it to avoid a silent fallback to
	 * f16 KV when a quantized cache was requested.
	 */
	llmKvQuantSupported?(): boolean;
	/**
	 * Open a streaming-LLM session against `ctx`. Failure throws
	 * `VoiceLifecycleError`. Close exactly once via `llmStreamClose`.
	 */
	llmStreamOpen?(args: {
		ctx: ElizaInferenceContextHandle;
		config: LlmStreamConfig;
	}): LlmStreamHandle;
	/** Feed a batch of pre-tokenized prompt tokens before the first `next`. */
	llmStreamPrefill?(args: {
		stream: LlmStreamHandle;
		tokens: Int32Array;
	}): void;
	/**
	 * Pull the next streaming step. Returns `null` when the runtime declined
	 * to emit tokens this call (rare — drafter rejected everything and the
	 * verifier had nothing to commit); poll again. `step.done === true` is
	 * the final step.
	 */
	llmStreamNext?(args: {
		stream: LlmStreamHandle;
		maxTokensPerStep?: number;
		maxTextBytes?: number;
	}): LlmStreamStep;
	/** Cancel in-flight generation; the next `_next` returns CANCELLED. */
	llmStreamCancel?(stream: LlmStreamHandle): void;
	/** Persist the session's slot KV state to disk. */
	llmStreamSaveSlot?(args: { stream: LlmStreamHandle; filename: string }): void;
	/** Restore a previously-saved slot KV file. Call before the first prefill/next. */
	llmStreamRestoreSlot?(args: {
		stream: LlmStreamHandle;
		filename: string;
	}): void;
	/** Close + free a streaming-LLM session. Idempotent on already-closed handles. */
	llmStreamClose?(stream: LlmStreamHandle): void;

	/* ---- Text embeddings (ABI v9) -------------------------------- */

	/**
	 * True when this build wires the fused text-embedding path
	 * (`eliza_inference_embed`). A v8 library returns false (symbol absent),
	 * so the default TEXT_EMBEDDING handler keeps the node-llama-cpp /
	 * libllama path.
	 */
	embedSupported?(): boolean;
	/**
	 * Compute a pooled, L2-normalized sentence embedding for `text` over the
	 * bundle's text model. `pooling` selects the strategy (default MEAN — the
	 * gte-small convention). Returns a `Float32Array` of length `n_embd`.
	 */
	embed?(args: {
		ctx: ElizaInferenceContextHandle;
		text: string;
		pooling?: number;
	}): Float32Array;

	/* ---- mmproj vision describe (ABI v9) ------------------------- */

	/**
	 * True when this build was compiled with vision (`-DELIZA_ENABLE_VISION`)
	 * and exports `eliza_inference_describe_image`. A v8 / vision-off library
	 * returns false, so the IMAGE_DESCRIPTION handler keeps the libllama mtmd
	 * path.
	 */
	visionSupported?(): boolean;
	/**
	 * Describe `imageBytes` (raw PNG/JPEG/WebP) through the text model's
	 * mmproj projector at `mmprojPath`. `prompt` defaults to a generic
	 * caption request. Returns the description text.
	 */
	describeImage?(args: {
		ctx: ElizaInferenceContextHandle;
		imageBytes: Uint8Array;
		mmprojPath: string;
		prompt?: string;
		maxTextBytes?: number;
	}): string;

	/* ---- Streaming mmproj vision describe (ABI v13) -------------- */

	/**
	 * True when this build wires token-by-token vision describe
	 * (`eliza_inference_describe_image_stream_open`). A <=v12 / vision-off
	 * library returns false, so the IMAGE_DESCRIPTION handler falls back to the
	 * buffered {@link describeImage}.
	 */
	visionStreamSupported?(): boolean;
	/**
	 * Open a streaming vision-describe session: prime an `LlmStreamHandle`'s KV
	 * with `imageBytes` (raw PNG/JPEG/WebP) + `prompt` through the mmproj at
	 * `mmprojPath`, then PULL tokens with the existing {@link llmStreamNext} loop
	 * and release via {@link llmStreamClose} — the same machinery as chat text.
	 * Throws `VoiceLifecycleError` when the build lacks vision streaming.
	 */
	describeImageStreamOpen?(args: {
		ctx: ElizaInferenceContextHandle;
		imageBytes: Uint8Array;
		mmprojPath: string;
		prompt?: string;
	}): LlmStreamHandle;

	/* ---- Tokenizer (ABI v9) -------------------------------------- */

	/**
	 * True when this build exposes the tokenizer over the loaded text vocab
	 * (`eliza_inference_tokenize`). A pre-v9 library returns false, so the
	 * desktop fused runtime refuses (libllama is retired — no tokenizer sidecar).
	 */
	tokenizeSupported?(): boolean;
	/**
	 * Tokenize `text` against the loaded text model's vocab. `addSpecial`
	 * (default true) adds BOS/EOS; `parseSpecial` (default false) renders
	 * special tokens from the input. Returns the token ids as an `Int32Array`.
	 */
	tokenize?(args: {
		ctx: ElizaInferenceContextHandle;
		text: string;
		addSpecial?: boolean;
		parseSpecial?: boolean;
	}): Int32Array;
	/**
	 * Detokenize `tokens` back to text against the loaded text model's vocab.
	 * `removeSpecial` (default false) strips BOS/EOS; `unparseSpecial`
	 * (default false) renders special tokens.
	 */
	detokenize?(args: {
		ctx: ElizaInferenceContextHandle;
		tokens: Int32Array;
		removeSpecial?: boolean;
		unparseSpecial?: boolean;
		maxTextBytes?: number;
	}): string;

	/* ---- End-of-turn scoring (ABI v11) -------------------------- */

	/**
	 * True when this build wires the fused end-of-turn scorer
	 * (`eliza_inference_llm_eot_score`). A v10 library returns false (symbol
	 * absent), so the composite EOT classifier uses the heuristic-only signal.
	 */
	eotSupported?(): boolean;
	/**
	 * Single causal forward pass over `tokens` (a tokenized partial transcript)
	 * returning the next-token softmax probability of `targetTokenId` (the
	 * end-of-turn marker, e.g. `<end_of_turn>`), plus the argmax next token and its
	 * probability. Runs on a dedicated scoring context over the loaded text
	 * model; KV is cleared per call so scores are independent.
	 */
	eotScore?(args: {
		ctx: ElizaInferenceContextHandle;
		tokens: Int32Array;
		targetTokenId: number;
	}): { targetProb: number; topToken: number; topProb: number };

	/* ---- Kokoro TTS (ABI v10) ----------------------------------- */

	/**
	 * True when this build linked Eliza-1's in-process Kokoro engine
	 * (`eliza_inference_kokoro_*`). A v9 library returns false (symbols
	 * absent), so the Kokoro FFI runtime refuses rather than falling back to
	 * the local-TCP `llama-server` route (forbidden on iOS / Google Play).
	 */
	kokoroSupported?(): boolean;
	/**
	 * Load the Kokoro GGUF at `ggufPath` and the voice preset `.bin` at
	 * `voiceBinPath` (raw fp32 ref_s, `styleDim` inner dim — 256 for v1.0)
	 * into `ctx`. Replaces any previously-loaded Kokoro model on the ctx.
	 * Throws `VoiceLifecycleError` on a negative return with the C diagnostic.
	 */
	kokoroLoad?(args: {
		ctx: ElizaInferenceContextHandle;
		ggufPath: string;
		voiceBinPath: string;
		styleDim?: number;
	}): void;
	/**
	 * Synthesize `text` through the loaded Kokoro model+voice at the model's
	 * native rate (24 kHz for v1.0). `speed` scales predicted durations
	 * (default 1.0). Allocates an output buffer of `maxSamples` fp32 samples,
	 * reads back the count the library wrote, and returns that slice.
	 */
	kokoroSynthesize?(args: {
		ctx: ElizaInferenceContextHandle;
		text: string;
		speed?: number;
		maxSamples: number;
	}): Float32Array;
	/** The loaded Kokoro model's audio sample rate (24000 for v1.0). */
	kokoroSampleRate?(ctx: ElizaInferenceContextHandle): number;
	/**
	 * Which G2P path the linked kokoro_lib uses (ABI v14). `"espeak"` when the
	 * lib links libespeak-ng (raw text is phonemized correctly in
	 * `kokoroSynthesize`); `"ascii"` when it only has the lossy grapheme
	 * fallback (the caller must feed IPA via `kokoroSynthesizeIpa`); `"unknown"`
	 * when the symbol is absent (a <=v13 library — the runtime keeps raw text).
	 */
	kokoroG2pKind?(
		ctx: ElizaInferenceContextHandle,
	): "espeak" | "ascii" | "unknown";
	/**
	 * Synthesize from precomputed espeak-ng IPA (ABI v14) — the intelligible
	 * path on espeak-less builds. The IPA is mapped straight to Kokoro vocab ids
	 * in the lib (bypassing its internal phonemizer). Same output contract as
	 * `kokoroSynthesize`.
	 */
	kokoroSynthesizeIpa?(args: {
		ctx: ElizaInferenceContextHandle;
		ipa: string;
		speed?: number;
		maxSamples: number;
	}): Float32Array;

	/** Best-effort dispose for the binding itself (closes the dlopen handle). */
	close(): void;
}

/* ---------------------------------------------------------------- */
/* Loader                                                           */
/* ---------------------------------------------------------------- */

/** Runtime detector: returns true when running under Bun. */
function isBunRuntime(): boolean {
	return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/**
 * Load `libelizainference` at `dylibPath` and bind every symbol
 * declared in `ffi.h`. The returned handle's methods delegate directly
 * to the library; they throw `VoiceLifecycleError` on any negative
 * return value or runtime fault.
 *
 * Throws synchronously (no Promise) when:
 *   - the JS runtime is not Bun (no FFI primitive available),
 *   - `dlopen` cannot find or open the library,
 *   - the library's reported ABI version does not match
 *     `ELIZA_INFERENCE_ABI_VERSION`.
 */
export function loadElizaInferenceFfi(dylibPath: string): ElizaInferenceFfi {
	if (!isBunRuntime()) {
		throw new VoiceLifecycleError(
			"kernel-missing",
			`[ffi-bindings] Cannot load libelizainference: current runtime is not Bun. ` +
				`The fused omnivoice FFI uses bun:ffi (production runs under Bun via Electrobun + Capacitor). ` +
				`process.versions=${JSON.stringify(process.versions)}`,
		);
	}
	if (!dylibPath || dylibPath.length === 0) {
		throw new VoiceLifecycleError(
			"kernel-missing",
			"[ffi-bindings] loadElizaInferenceFfi: dylibPath is required",
		);
	}
	return bindWithBunFfi(dylibPath);
}

/* ---------------------------------------------------------------- */
/* Bun:ffi binding                                                  */
/* ---------------------------------------------------------------- */

interface BunFfiSymbols {
	eliza_inference_abi_version: () => unknown;
	eliza_inference_create: (bundleDir: unknown, outErr: unknown) => unknown;
	eliza_inference_destroy: (ctx: bigint) => void;
	eliza_inference_mmap_acquire: (
		ctx: bigint,
		region: unknown,
		outErr: unknown,
	) => number;
	eliza_inference_mmap_evict: (
		ctx: bigint,
		region: unknown,
		outErr: unknown,
	) => number;
	eliza_inference_tts_synthesize: (
		ctx: bigint,
		text: unknown,
		textLen: bigint | number,
		speaker: unknown,
		outPcm: unknown,
		maxSamples: bigint | number,
		outErr: unknown,
	) => number;
	eliza_inference_asr_transcribe: (
		ctx: bigint,
		pcm: unknown,
		nSamples: bigint | number,
		sampleRateHz: number,
		outText: unknown,
		maxTextBytes: bigint | number,
		outErr: unknown,
	) => number;
	eliza_inference_asr_timestamps_supported?: () => number;
	eliza_inference_asr_transcribe_timed?: (
		ctx: bigint,
		pcm: unknown,
		nSamples: bigint | number,
		sampleRateHz: number,
		outText: unknown,
		maxTextBytes: bigint | number,
		outWordStartMs: unknown,
		outWordEndMs: unknown,
		ioNWords: unknown,
		outErr: unknown,
	) => number;
	eliza_inference_tts_stream_supported: () => number;
	eliza_inference_tts_synthesize_stream: (
		ctx: bigint,
		text: unknown,
		textLen: bigint | number,
		speaker: unknown,
		onChunk: unknown,
		userData: bigint | number,
		outErr: unknown,
	) => number;
	eliza_inference_cancel_tts: (ctx: bigint, outErr: unknown) => number;
	eliza_inference_set_verifier_callback: (
		ctx: bigint,
		cb: unknown,
		userData: bigint | number,
		outErr: unknown,
	) => number;
	eliza_inference_encode_reference?: (
		ctx: bigint,
		pcm: unknown,
		nSamples: bigint | number,
		sampleRateHz: number,
		outK: unknown,
		outRefT: unknown,
		outTokens: unknown,
		outErr: unknown,
	) => number;
	eliza_inference_free_tokens?: (tokens: bigint | number) => void;
	eliza_inference_vad_supported?: () => number;
	eliza_inference_vad_open?: (
		ctx: bigint,
		sampleRateHz: number,
		outErr: unknown,
	) => unknown;
	eliza_inference_vad_process?: (
		vad: bigint,
		pcm: unknown,
		nSamples: bigint | number,
		outProbability: unknown,
		outErr: unknown,
	) => number;
	eliza_inference_vad_reset?: (vad: bigint, outErr: unknown) => number;
	eliza_inference_vad_close?: (vad: bigint) => void;
	eliza_inference_wakeword_supported?: () => number;
	eliza_inference_wakeword_open?: (
		ctx: bigint,
		sampleRateHz: number,
		headName: unknown,
		outErr: unknown,
	) => unknown;
	eliza_inference_wakeword_score?: (
		wake: bigint,
		pcm: unknown,
		nSamples: bigint | number,
		outProbability: unknown,
		outErr: unknown,
	) => number;
	eliza_inference_wakeword_reset?: (wake: bigint, outErr: unknown) => number;
	eliza_inference_wakeword_close?: (wake: bigint) => void;
	eliza_inference_speaker_supported?: () => number;
	eliza_inference_speaker_open?: (
		ctx: bigint,
		ggufPath: unknown,
		outErr: unknown,
	) => unknown;
	eliza_inference_speaker_embed?: (
		speaker: bigint,
		pcm: unknown,
		nSamples: bigint | number,
		outEmbedding: unknown,
		outErr: unknown,
	) => number;
	eliza_inference_speaker_close?: (speaker: bigint) => void;
	eliza_inference_diariz_supported?: () => number;
	eliza_inference_diariz_open?: (
		ctx: bigint,
		ggufPath: unknown,
		outErr: unknown,
	) => unknown;
	eliza_inference_diariz_segment?: (
		diariz: bigint,
		pcm: unknown,
		nSamples: bigint | number,
		outLabels: unknown,
		ioNLabels: unknown,
		outErr: unknown,
	) => number;
	eliza_inference_diariz_close?: (diariz: bigint) => void;
	eliza_inference_asr_stream_supported: () => number;
	eliza_inference_asr_stream_open: (
		ctx: bigint,
		sampleRateHz: number,
		outErr: unknown,
	) => unknown;
	eliza_inference_asr_stream_feed: (
		stream: bigint,
		pcm: unknown,
		nSamples: bigint | number,
		outErr: unknown,
	) => number;
	eliza_inference_asr_stream_partial: (
		stream: bigint,
		outText: unknown,
		maxTextBytes: bigint | number,
		outTokens: unknown,
		ioNTokens: unknown,
		outErr: unknown,
	) => number;
	eliza_inference_asr_stream_finish: (
		stream: bigint,
		outText: unknown,
		maxTextBytes: bigint | number,
		outTokens: unknown,
		ioNTokens: unknown,
		outErr: unknown,
	) => number;
	eliza_inference_asr_stream_close: (stream: bigint) => void;
	eliza_inference_free_string: (str: bigint | number) => void;
	// Streaming LLM (additive). Optional — transitional builds may omit.
	// ABI v8 capability probes — absent on v7 (treated as unsupported).
	eliza_inference_llm_mtp_supported?: () => number;
	eliza_inference_llm_kv_quant_supported?: () => number;
	eliza_inference_llm_stream_open?: (
		ctx: bigint,
		cfg: unknown,
		outErr: unknown,
	) => unknown;
	eliza_inference_llm_stream_prefill?: (
		stream: bigint,
		tokens: unknown,
		nTokens: bigint | number,
		outErr: unknown,
	) => number;
	eliza_inference_llm_stream_next?: (
		stream: bigint,
		tokensOut: unknown,
		tokensCapacity: bigint | number,
		numTokensOut: unknown,
		textOut: unknown,
		textCapacity: bigint | number,
		drafterDraftedOut: unknown,
		drafterAcceptedOut: unknown,
		outErr: unknown,
	) => number;
	eliza_inference_llm_stream_cancel?: (stream: bigint) => number;
	eliza_inference_llm_stream_save_slot?: (
		stream: bigint,
		filename: unknown,
		outErr: unknown,
	) => number;
	eliza_inference_llm_stream_restore_slot?: (
		stream: bigint,
		filename: unknown,
		outErr: unknown,
	) => number;
	eliza_inference_llm_stream_close?: (stream: bigint) => void;
	// Text embeddings (ABI v9). Optional — absent on v8 builds.
	eliza_inference_embed_supported?: () => number;
	eliza_inference_embed?: (
		ctx: bigint,
		text: unknown,
		textLen: bigint | number,
		pooling: number,
		outEmbedding: unknown,
		outCapacity: bigint | number,
		outDim: unknown,
		outErr: unknown,
	) => number;
	// mmproj vision describe (ABI v9). Optional — absent on v8 / vision-off builds.
	eliza_inference_vision_supported?: () => number;
	eliza_inference_describe_image?: (
		ctx: bigint,
		imageBytes: unknown,
		nBytes: bigint | number,
		mmprojPath: unknown,
		prompt: unknown,
		outText: unknown,
		maxTextBytes: bigint | number,
		outErr: unknown,
	) => number;
	// Streaming mmproj vision describe (ABI v13). Optional — absent on <=v12
	// builds (the probe then reports unsupported and IMAGE_DESCRIPTION falls back
	// to the buffered `eliza_inference_describe_image`). `_stream_open` returns an
	// EliLlmStream* (as a pointer/bigint) primed with the image+prompt KV; the
	// caller drives the existing `eliza_inference_llm_stream_next` loop and frees
	// via `eliza_inference_llm_stream_close`.
	eliza_inference_vision_stream_supported?: () => number;
	eliza_inference_describe_image_stream_open?: (
		ctx: bigint,
		imageBytes: unknown,
		nBytes: bigint | number,
		mmprojPath: unknown,
		prompt: unknown,
		outErr: unknown,
	) => bigint;
	// Tokenizer (ABI v9). Optional — absent on v8 builds.
	eliza_inference_tokenize_supported?: () => number;
	eliza_inference_tokenize?: (
		ctx: bigint,
		text: unknown,
		textLen: bigint | number,
		addSpecial: number,
		parseSpecial: number,
		outTokens: unknown,
		outN: unknown,
		outErr: unknown,
	) => number;
	eliza_inference_detokenize?: (
		ctx: bigint,
		tokens: unknown,
		nTokens: bigint | number,
		removeSpecial: number,
		unparseSpecial: number,
		outText: unknown,
		maxTextBytes: bigint | number,
		outErr: unknown,
	) => number;
	// End-of-turn scoring (ABI v11). Optional — absent on v10 builds (the probe
	// then reports unsupported and the composite EOT classifier uses the
	// heuristic-only signal).
	eliza_inference_llm_eot_supported?: () => number;
	eliza_inference_llm_eot_score?: (
		ctx: bigint,
		tokenIds: unknown,
		numTokens: bigint | number,
		targetTokenId: number,
		outTargetProb: unknown,
		outTopToken: unknown,
		outTopProb: unknown,
		outErr: unknown,
	) => number;
	// Kokoro TTS (ABI v10). Optional — absent on v9 builds (the probe then
	// reports unsupported and the Kokoro FFI runtime refuses).
	eliza_inference_kokoro_supported?: () => number;
	eliza_inference_kokoro_load?: (
		ctx: bigint,
		ggufPath: unknown,
		voiceBinPath: unknown,
		styleDim: number,
		outErr: unknown,
	) => number;
	eliza_inference_kokoro_synthesize?: (
		ctx: bigint,
		text: unknown,
		textLen: bigint | number,
		speed: number,
		outPcm: unknown,
		maxSamples: bigint | number,
		outErr: unknown,
	) => number;
	eliza_inference_kokoro_sample_rate?: (ctx: bigint) => number;
	// Kokoro IPA input + G2P-kind (ABI v14). Optional — absent on <=v13 builds.
	eliza_inference_kokoro_g2p_kind?: (ctx: bigint) => number;
	eliza_inference_kokoro_synthesize_ipa?: (
		ctx: bigint,
		ipa: unknown,
		ipaLen: bigint | number,
		speed: number,
		outPcm: unknown,
		maxSamples: bigint | number,
		outErr: unknown,
	) => number;
}

interface BunFfiLib {
	symbols: BunFfiSymbols;
	close(): void;
}

interface BunFfiJSCallback {
	readonly ptr: bigint | number;
	close(): void;
}

interface BunFfiModule {
	dlopen(path: string, defs: Record<string, unknown>): BunFfiLib;
	FFIType: Record<string, number>;
	ptr(value: ArrayBufferView): unknown;
	CString: new (ptr: unknown) => { toString(): string };
	read: {
		ptr(buf: unknown, offset?: number): bigint;
		i32(buf: unknown, offset?: number): number;
		u64(buf: unknown, offset?: number): bigint;
	};
	toArrayBuffer(
		ptr: bigint | number,
		byteOffset?: number,
		byteLength?: number,
	): ArrayBuffer;
	JSCallback: new <F extends (...args: never[]) => unknown>(
		fn: F,
		def: { args: number[]; returns: number },
	) => BunFfiJSCallback;
}

/**
 * Resolve `bun:ffi` synchronously via the Bun-injected `require`.
 * Bun exposes a CJS `require` even from ESM modules, and `bun:ffi` is
 * a built-in importable that way. Doing this dynamically (rather than a
 * static `import "bun:ffi"`) keeps the module loadable under plain Node
 * for the parts of the test suite that don't need the FFI.
 */
function loadBunFfiModule(): BunFfiModule {
	const req: ((id: string) => unknown) | undefined = (
		globalThis as { Bun?: { __require?: (id: string) => unknown } }
	).Bun?.__require;
	if (typeof req === "function") {
		return req("bun:ffi") as BunFfiModule;
	}
	// Fallback to `module.createRequire` on the current file when running
	// under Bun via an ESM entry without `Bun.__require`. This is rare —
	// current Bun exposes `Bun.__require` — but we keep the path explicit
	// so the failure mode is `MODULE_NOT_FOUND` (a real error), not a
	// silent fall-through.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const mod = require("node:module") as {
		createRequire: (filename: string) => (id: string) => unknown;
	};
	const r = mod.createRequire(import.meta.url);
	return r("bun:ffi") as BunFfiModule;
}

function bindWithBunFfi(dylibPath: string): ElizaInferenceFfi {
	let ffi: BunFfiModule;
	try {
		ffi = loadBunFfiModule();
	} catch (err) {
		throw new VoiceLifecycleError(
			"kernel-missing",
			`[ffi-bindings] Cannot load bun:ffi while opening ${dylibPath}: ${formatFfiError(err)}`,
		);
	}
	const T = ffi.FFIType;

	// Windows-only: make the fused lib's co-located backends (ggml*/llama*/mtmd
	// .dll) resolvable before dlopen, which otherwise fails with error 126. See
	// ensureWin32DllSearchDir for the full rationale.
	ensureWin32DllSearchDir(path.dirname(dylibPath));

	// All `char *` arguments are typed as T.ptr — Bun's `T.cstring` is a
	// RETURN-only type for "library hands back a NUL-terminated string".
	// For inputs we encode UTF-8 to a NUL-terminated Buffer on the JS
	// side and pass `ffi.ptr(buffer)`.
	let lib: BunFfiLib | null = null;
	let nativeVadSymbolsAvailable = true;
	const nativeVadDefs = {
		// Native Silero VAD (ABI v3). These are additive; some transitional
		// builds may report ABI v3 before carrying the VAD symbols, so bind
		// them opportunistically and advertise unsupported if absent.
		eliza_inference_vad_supported: { args: [], returns: T.i32 },
		eliza_inference_vad_open: {
			args: [T.ptr, T.i32, T.ptr],
			returns: T.ptr,
		},
		eliza_inference_vad_process: {
			args: [T.usize, T.ptr, T.usize, T.ptr, T.ptr],
			returns: T.i32,
		},
		eliza_inference_vad_reset: { args: [T.usize, T.ptr], returns: T.i32 },
		eliza_inference_vad_close: { args: [T.usize], returns: T.void },
	};
	// Native openWakeWord (ABI v5). Additive; transitional builds may report
	// v5 before the wake-word symbols ship, so bind opportunistically and
	// advertise unsupported when absent. The wake-word path throws a
	// structured "runtime not ready" error in that case (no ONNX fallback).
	let wakewordSymbolsAvailable = true;
	const wakewordDefs = {
		eliza_inference_wakeword_supported: { args: [], returns: T.i32 },
		eliza_inference_wakeword_open: {
			// ctx, sample_rate_hz, head_name (cstr), out_error
			args: [T.ptr, T.i32, T.ptr, T.ptr],
			returns: T.ptr,
		},
		eliza_inference_wakeword_score: {
			// wake (usize), pcm (ptr), n_samples (usize), out_prob (ptr),
			// out_error (ptr)
			args: [T.usize, T.ptr, T.usize, T.ptr, T.ptr],
			returns: T.i32,
		},
		eliza_inference_wakeword_reset: {
			args: [T.usize, T.ptr],
			returns: T.i32,
		},
		eliza_inference_wakeword_close: {
			args: [T.usize],
			returns: T.void,
		},
	};
	// Native voice classifiers (ABI v6): WeSpeaker speaker encoder + pyannote
	// diarizer, fused into the one libelizainference handle. Additive;
	// transitional builds may report v6 before the classifier symbols ship, so
	// bind opportunistically and advertise unsupported when absent (the
	// fused encoder/diarizer classes throw a structured error in that case —
	// no standalone libvoice_classifier fallback).
	let speakerSymbolsAvailable = true;
	const speakerDefs = {
		eliza_inference_speaker_supported: { args: [], returns: T.i32 },
		eliza_inference_speaker_open: {
			// ctx, gguf_path (cstr or NULL), out_error
			args: [T.ptr, T.ptr, T.ptr],
			returns: T.ptr,
		},
		eliza_inference_speaker_embed: {
			// speaker (usize), pcm (ptr), n_samples (usize), out_embedding (ptr),
			// out_error (ptr)
			args: [T.usize, T.ptr, T.usize, T.ptr, T.ptr],
			returns: T.i32,
		},
		eliza_inference_speaker_close: {
			args: [T.usize],
			returns: T.void,
		},
	};
	let diarizSymbolsAvailable = true;
	const diarizDefs = {
		eliza_inference_diariz_supported: { args: [], returns: T.i32 },
		eliza_inference_diariz_open: {
			// ctx, gguf_path (cstr or NULL), out_error
			args: [T.ptr, T.ptr, T.ptr],
			returns: T.ptr,
		},
		eliza_inference_diariz_segment: {
			// diariz (usize), pcm (ptr), n_samples (usize), out_labels (ptr),
			// io_n_labels (ptr), out_error (ptr)
			args: [T.usize, T.ptr, T.usize, T.ptr, T.ptr, T.ptr],
			returns: T.i32,
		},
		eliza_inference_diariz_close: {
			args: [T.usize],
			returns: T.void,
		},
	};
	// Streaming LLM (additive on top of v3). Bound opportunistically — when
	// absent the runner reports native streaming as unsupported.
	let llmStreamSymbolsAvailable = true;
	// ABI v8 streaming-LLM capability probes. Bound as their own family so a
	// v7 library (which has the `llm_stream_*` symbols but not these probes)
	// still binds `llmStreamDefs` while reporting MTP / KV-quant unsupported.
	let llmCapabilitySymbolsAvailable = true;
	const llmCapabilityDefs = {
		eliza_inference_llm_mtp_supported: { args: [], returns: T.i32 },
		eliza_inference_llm_kv_quant_supported: { args: [], returns: T.i32 },
	};
	const llmStreamDefs = {
		eliza_inference_llm_stream_open: {
			// ctx (ptr), cfg (ptr to eliza_llm_stream_config_t), out_error (ptr)
			args: [T.ptr, T.ptr, T.ptr],
			returns: T.ptr,
		},
		eliza_inference_llm_stream_prefill: {
			args: [T.usize, T.ptr, T.usize, T.ptr],
			returns: T.i32,
		},
		eliza_inference_llm_stream_next: {
			// stream, tokens_out, tokens_cap, num_tokens_out, text_out,
			// text_cap, drafter_drafted_out, drafter_accepted_out, out_error
			args: [
				T.usize,
				T.ptr,
				T.usize,
				T.ptr,
				T.ptr,
				T.usize,
				T.ptr,
				T.ptr,
				T.ptr,
			],
			returns: T.i32,
		},
		eliza_inference_llm_stream_cancel: {
			args: [T.usize],
			returns: T.i32,
		},
		eliza_inference_llm_stream_save_slot: {
			args: [T.usize, T.ptr, T.ptr],
			returns: T.i32,
		},
		eliza_inference_llm_stream_restore_slot: {
			args: [T.usize, T.ptr, T.ptr],
			returns: T.i32,
		},
		eliza_inference_llm_stream_close: {
			args: [T.usize],
			returns: T.void,
		},
	};
	const referenceEncodeDefs = {
		// OmniVoice reference encode (ABI v4) — optional for transitional
		// fused libraries. Default TTS/ASR must still load when reference-clone
		// freezing is unavailable; encodeReferenceSupported() exposes that state.
		eliza_inference_encode_reference: {
			// ctx, pcm, n_samples, sample_rate_hz, out_K, out_ref_T, out_tokens (int**), out_error
			args: [T.ptr, T.ptr, T.usize, T.i32, T.ptr, T.ptr, T.ptr, T.ptr],
			returns: T.i32,
		},
		eliza_inference_free_tokens: { args: [T.usize], returns: T.void },
	};
	let referenceEncodeSymbolsAvailable = true;
	// Text-adjacent modalities (ABI v9): embeddings, mmproj vision describe, and
	// the tokenizer over the loaded text vocab. They ship together in a v9
	// build; bound and gated as one block layered on top of the v8 surface so
	// the cascade peels them when a v8 library is loaded. `free_tokens` is
	// re-listed here (a v9 build that lacks reference-encode still needs it for
	// `tokenize`'s buffer); identical defs merge harmlessly.
	let textModalitiesSymbolsAvailable = true;
	const textModalitiesDefs = {
		eliza_inference_embed_supported: { args: [], returns: T.i32 },
		eliza_inference_embed: {
			// ctx, text, text_len, pooling, out_embedding, out_capacity, out_dim, out_error
			args: [T.ptr, T.ptr, T.usize, T.i32, T.ptr, T.usize, T.ptr, T.ptr],
			returns: T.i32,
		},
		eliza_inference_vision_supported: { args: [], returns: T.i32 },
		eliza_inference_describe_image: {
			// ctx, image_bytes, n_bytes, mmproj_path, prompt, out_text, max_text_bytes, out_error
			args: [T.ptr, T.ptr, T.usize, T.ptr, T.ptr, T.ptr, T.usize, T.ptr],
			returns: T.i32,
		},
		eliza_inference_tokenize_supported: { args: [], returns: T.i32 },
		eliza_inference_tokenize: {
			// ctx, text, text_len, add_special, parse_special, out_tokens (int**), out_n, out_error
			args: [T.ptr, T.ptr, T.usize, T.i32, T.i32, T.ptr, T.ptr, T.ptr],
			returns: T.i32,
		},
		eliza_inference_detokenize: {
			// ctx, tokens, n_tokens, remove_special, unparse_special, out_text, max_text_bytes, out_error
			args: [T.ptr, T.ptr, T.usize, T.i32, T.i32, T.ptr, T.usize, T.ptr],
			returns: T.i32,
		},
		eliza_inference_free_tokens: { args: [T.usize], returns: T.void },
	};
	// Kokoro TTS (ABI v10): the in-process Kokoro engine folded into the fused
	// handle so the mobile path stops POSTing to the local-TCP llama-server
	// route. Bound as its own family layered on top of the v9 surface; the
	// cascade peels it when a v9 library is loaded. `kokoroSupported()` reports
	// false in that case and the Kokoro FFI runtime refuses (no TCP fallback).
	let kokoroSymbolsAvailable = true;
	const kokoroDefs = {
		eliza_inference_kokoro_supported: { args: [], returns: T.i32 },
		eliza_inference_kokoro_load: {
			// ctx, gguf_path, voice_bin_path, style_dim, out_error
			args: [T.ptr, T.ptr, T.ptr, T.i32, T.ptr],
			returns: T.i32,
		},
		eliza_inference_kokoro_synthesize: {
			// ctx, text, text_len, speed, out_pcm, max_samples, out_error
			args: [T.ptr, T.ptr, T.usize, T.f32, T.ptr, T.usize, T.ptr],
			returns: T.i32,
		},
		eliza_inference_kokoro_sample_rate: { args: [T.ptr], returns: T.i32 },
	};
	// Kokoro IPA input + G2P-kind query (ABI v14): an espeak-less fused build
	// phonemizes raw text with a lossy ASCII grapheme fallback (unintelligible).
	// `g2p_kind` lets the runtime detect that and route through `synthesize_ipa`
	// with espeak-ng-WASM IPA instead (#11776). Layered on top of v13; the
	// cascade peels it when a <=v13 library is loaded (the g2p-kind query then
	// reports "unknown" and the runtime keeps the raw-text path with a warning).
	let kokoroG2pSymbolsAvailable = true;
	const kokoroG2pDefs = {
		eliza_inference_kokoro_g2p_kind: { args: [T.ptr], returns: T.i32 },
		eliza_inference_kokoro_synthesize_ipa: {
			// ctx, ipa, ipa_len, speed, out_pcm, max_samples, out_error
			args: [T.ptr, T.ptr, T.usize, T.f32, T.ptr, T.usize, T.ptr],
			returns: T.i32,
		},
	};
	// End-of-turn scoring (ABI v11): a single causal forward pass over a
	// pre-tokenized partial transcript returns P(end-of-turn token). Layered on
	// top of the v10 surface; the cascade peels it when a v10 library is loaded
	// (the `eotSupported()` probe then reports false and the composite EOT
	// classifier falls back to the heuristic-only signal).
	let eotSymbolsAvailable = true;
	const eotDefs = {
		eliza_inference_llm_eot_supported: { args: [], returns: T.i32 },
		eliza_inference_llm_eot_score: {
			// ctx, token_ids, num_tokens, target_token_id,
			// out_target_prob, out_top_token, out_top_prob, out_error
			args: [T.ptr, T.ptr, T.usize, T.i32, T.ptr, T.ptr, T.ptr, T.ptr],
			returns: T.i32,
		},
	};
	// ABI v12 — fused ASR word timestamps.
	let timedAsrSymbolsAvailable = true;
	const timedAsrDefs = {
		eliza_inference_asr_timestamps_supported: { args: [], returns: T.i32 },
		eliza_inference_asr_transcribe_timed: {
			// ctx, pcm, n_samples, sr, out_text, max_text_bytes,
			// out_word_start_ms, out_word_end_ms, io_n_words, out_error
			args: [
				T.ptr,
				T.ptr,
				T.usize,
				T.i32,
				T.ptr,
				T.usize,
				T.ptr,
				T.ptr,
				T.ptr,
				T.ptr,
			],
			returns: T.i32,
		},
	};
	// Streaming mmproj vision describe (ABI v13): open returns an EliLlmStream*
	// primed with the image+prompt KV; the caller drives the existing
	// `eliza_inference_llm_stream_next` loop. Layered on top of the v12 surface;
	// the cascade peels it when a <=v12 library is loaded (the
	// `visionStreamSupported()` probe then reports false and IMAGE_DESCRIPTION
	// falls back to the buffered `eliza_inference_describe_image`).
	let visionStreamSymbolsAvailable = true;
	const visionStreamDefs = {
		eliza_inference_vision_stream_supported: { args: [], returns: T.i32 },
		eliza_inference_describe_image_stream_open: {
			// ctx, image_bytes, n_bytes, mmproj_path, prompt, out_error -> EliLlmStream*
			args: [T.ptr, T.ptr, T.usize, T.ptr, T.ptr, T.ptr],
			returns: T.ptr,
		},
	};
	const coreDefs = {
		eliza_inference_abi_version: { args: [], returns: T.cstring },
		eliza_inference_create: {
			args: [T.ptr, T.ptr],
			returns: T.ptr,
		},
		eliza_inference_destroy: { args: [T.ptr], returns: T.void },
		eliza_inference_mmap_acquire: {
			args: [T.ptr, T.ptr, T.ptr],
			returns: T.i32,
		},
		eliza_inference_mmap_evict: {
			args: [T.ptr, T.ptr, T.ptr],
			returns: T.i32,
		},
		eliza_inference_tts_synthesize: {
			args: [T.ptr, T.ptr, T.usize, T.ptr, T.ptr, T.usize, T.ptr],
			returns: T.i32,
		},
		eliza_inference_asr_transcribe: {
			args: [T.ptr, T.ptr, T.usize, T.i32, T.ptr, T.usize, T.ptr],
			returns: T.i32,
		},
		// Streaming TTS + native verifier callback (ABI v2). The
		// function-pointer args are passed as raw pointer values
		// (`JSCallback.ptr`, or 0n to clear) so this binding owns the
		// JSCallback lifetime explicitly — see `ttsSynthesizeStream` /
		// `setVerifierCallback` below.
		eliza_inference_tts_stream_supported: { args: [], returns: T.i32 },
		eliza_inference_tts_synthesize_stream: {
			// ctx, text, text_len, speaker, on_chunk (fn ptr), user_data, out_error
			args: [T.ptr, T.ptr, T.usize, T.ptr, T.usize, T.usize, T.ptr],
			returns: T.i32,
		},
		eliza_inference_cancel_tts: { args: [T.ptr, T.ptr], returns: T.i32 },
		eliza_inference_set_verifier_callback: {
			// ctx, cb (fn ptr — 0 to clear), user_data, out_error
			args: [T.ptr, T.usize, T.usize, T.ptr],
			returns: T.i32,
		},
		// Streaming ASR (ABI v2).
		eliza_inference_asr_stream_supported: { args: [], returns: T.i32 },
		eliza_inference_asr_stream_open: {
			args: [T.ptr, T.i32, T.ptr],
			returns: T.ptr,
		},
		eliza_inference_asr_stream_feed: {
			// stream handle is a raw C pointer → pass as usize.
			args: [T.usize, T.ptr, T.usize, T.ptr],
			returns: T.i32,
		},
		eliza_inference_asr_stream_partial: {
			args: [T.usize, T.ptr, T.usize, T.ptr, T.ptr, T.ptr],
			returns: T.i32,
		},
		eliza_inference_asr_stream_finish: {
			args: [T.usize, T.ptr, T.usize, T.ptr, T.ptr, T.ptr],
			returns: T.i32,
		},
		eliza_inference_asr_stream_close: { args: [T.usize], returns: T.void },
		// Bun 1.3.x accepts raw pointer values passed back into C as
		// `usize`, while `ptr` is for JS-owned ArrayBuffer pointers.
		eliza_inference_free_string: { args: [T.usize], returns: T.void },
	};
	// Try the maximal additive symbol set first, then progressively drop
	// optional families. Each fallback flips a sentinel so `*Supported()` probes
	// report false instead of making an unavailable native call.
	// The v6 voice-classifier families (speaker encoder + diarizer) ship
	// together in the fused build, so they are bound and gated as one
	// `classifiers` block layered on top of the v5 wake-word family. The
	// cascade peels them in priority order: full v6 → v6-without-classifiers
	// (a real v5 build) → progressively smaller. Each rung flips a sentinel so
	// `*Supported()` reports false instead of calling an unbound symbol.
	const classifierDefs = { ...speakerDefs, ...diarizDefs };
	const attempts = [
		{
			// Full v14 surface (v13 + Kokoro IPA input + G2P-kind query).
			defs: {
				...coreDefs,
				...referenceEncodeDefs,
				...nativeVadDefs,
				...wakewordDefs,
				...classifierDefs,
				...llmStreamDefs,
				...llmCapabilityDefs,
				...textModalitiesDefs,
				...kokoroDefs,
				...kokoroG2pDefs,
				...eotDefs,
				...timedAsrDefs,
				...visionStreamDefs,
			},
			referenceEncode: true,
			nativeVad: true,
			wakeword: true,
			classifiers: true,
			llmStream: true,
			llmCapability: true,
			textModalities: true,
			kokoro: true,
			kokoroG2p: true,
			eot: true,
			timedAsr: true,
			visionStream: true,
		},
		{
			// Develop-pinned fork lineage: v12 + Kokoro IPA (v14) WITHOUT the
			// main-lineage vision-stream (v13) symbols. The fork advanced
			// 12 -> 14 for Kokoro IPA (fork-sync #11386), so this lib reports
			// v14 + kokoro-g2p but has no vision-stream. Accepted via the
			// exact-version clause; visionStreamSupported() reports false.
			defs: {
				...coreDefs,
				...referenceEncodeDefs,
				...nativeVadDefs,
				...wakewordDefs,
				...classifierDefs,
				...llmStreamDefs,
				...llmCapabilityDefs,
				...textModalitiesDefs,
				...kokoroDefs,
				...kokoroG2pDefs,
				...eotDefs,
				...timedAsrDefs,
			},
			referenceEncode: true,
			nativeVad: true,
			wakeword: true,
			classifiers: true,
			llmStream: true,
			llmCapability: true,
			textModalities: true,
			kokoro: true,
			kokoroG2p: true,
			eot: true,
			timedAsr: true,
		},
		{
			// Full v13 surface (v12 + token-by-token mmproj vision describe); a
			// v13 build lacks the v14 Kokoro IPA / G2P-kind symbols.
			defs: {
				...coreDefs,
				...referenceEncodeDefs,
				...nativeVadDefs,
				...wakewordDefs,
				...classifierDefs,
				...llmStreamDefs,
				...llmCapabilityDefs,
				...textModalitiesDefs,
				...kokoroDefs,
				...eotDefs,
				...timedAsrDefs,
				...visionStreamDefs,
			},
			referenceEncode: true,
			nativeVad: true,
			wakeword: true,
			classifiers: true,
			llmStream: true,
			llmCapability: true,
			textModalities: true,
			kokoro: true,
			eot: true,
			timedAsr: true,
			visionStream: true,
		},
		{
			// Full v12 surface (v11 + the in-process ASR word-timestamp decoder);
			// a v12 build lacks the v13 streaming-vision symbols.
			defs: {
				...coreDefs,
				...referenceEncodeDefs,
				...nativeVadDefs,
				...wakewordDefs,
				...classifierDefs,
				...llmStreamDefs,
				...llmCapabilityDefs,
				...textModalitiesDefs,
				...kokoroDefs,
				...eotDefs,
				...timedAsrDefs,
			},
			referenceEncode: true,
			nativeVad: true,
			wakeword: true,
			classifiers: true,
			llmStream: true,
			llmCapability: true,
			textModalities: true,
			kokoro: true,
			eot: true,
			timedAsr: true,
		},
		{
			// Full v11 surface (v10 + the in-process end-of-turn scorer); a v11
			// build lacks the v12 timed-ASR symbols.
			defs: {
				...coreDefs,
				...referenceEncodeDefs,
				...nativeVadDefs,
				...wakewordDefs,
				...classifierDefs,
				...llmStreamDefs,
				...llmCapabilityDefs,
				...textModalitiesDefs,
				...kokoroDefs,
				...eotDefs,
			},
			referenceEncode: true,
			nativeVad: true,
			wakeword: true,
			classifiers: true,
			llmStream: true,
			llmCapability: true,
			textModalities: true,
			kokoro: true,
			eot: true,
			timedAsr: false,
		},
		{
			// Full v10 surface (v9 + the in-process Kokoro block).
			defs: {
				...coreDefs,
				...referenceEncodeDefs,
				...nativeVadDefs,
				...wakewordDefs,
				...classifierDefs,
				...llmStreamDefs,
				...llmCapabilityDefs,
				...textModalitiesDefs,
				...kokoroDefs,
			},
			referenceEncode: true,
			nativeVad: true,
			wakeword: true,
			classifiers: true,
			llmStream: true,
			llmCapability: true,
			textModalities: true,
			kokoro: true,
		},
		{
			// Full v9 surface (no v10 Kokoro block).
			defs: {
				...coreDefs,
				...referenceEncodeDefs,
				...nativeVadDefs,
				...wakewordDefs,
				...classifierDefs,
				...llmStreamDefs,
				...llmCapabilityDefs,
				...textModalitiesDefs,
			},
			referenceEncode: true,
			nativeVad: true,
			wakeword: true,
			classifiers: true,
			llmStream: true,
			llmCapability: true,
			textModalities: true,
		},
		{
			// Full v8 surface (no v9 text-modality block).
			defs: {
				...coreDefs,
				...referenceEncodeDefs,
				...nativeVadDefs,
				...wakewordDefs,
				...classifierDefs,
				...llmStreamDefs,
				...llmCapabilityDefs,
			},
			referenceEncode: true,
			nativeVad: true,
			wakeword: true,
			classifiers: true,
			llmStream: true,
			llmCapability: true,
			textModalities: false,
		},
		{
			defs: {
				...coreDefs,
				...nativeVadDefs,
				...wakewordDefs,
				...classifierDefs,
				...llmStreamDefs,
				...llmCapabilityDefs,
			},
			referenceEncode: false,
			nativeVad: true,
			wakeword: true,
			classifiers: true,
			llmStream: true,
			llmCapability: true,
			textModalities: false,
		},
		{
			defs: {
				...coreDefs,
				...referenceEncodeDefs,
				...nativeVadDefs,
				...wakewordDefs,
				...llmStreamDefs,
			},
			referenceEncode: true,
			nativeVad: true,
			wakeword: true,
			classifiers: false,
			llmStream: true,
			llmCapability: false,
		},
		{
			defs: {
				...coreDefs,
				...nativeVadDefs,
				...wakewordDefs,
				...llmStreamDefs,
			},
			referenceEncode: false,
			nativeVad: true,
			wakeword: true,
			classifiers: false,
			llmStream: true,
			llmCapability: false,
		},
		{
			defs: {
				...coreDefs,
				...referenceEncodeDefs,
				...nativeVadDefs,
				...llmStreamDefs,
			},
			referenceEncode: true,
			nativeVad: true,
			wakeword: false,
			classifiers: false,
			llmStream: true,
			llmCapability: false,
		},
		{
			defs: { ...coreDefs, ...nativeVadDefs, ...llmStreamDefs },
			referenceEncode: false,
			nativeVad: true,
			wakeword: false,
			classifiers: false,
			llmStream: true,
			llmCapability: false,
		},
		{
			defs: { ...coreDefs, ...referenceEncodeDefs, ...nativeVadDefs },
			referenceEncode: true,
			nativeVad: true,
			wakeword: false,
			classifiers: false,
			llmStream: false,
			llmCapability: false,
		},
		{
			defs: { ...coreDefs, ...nativeVadDefs },
			referenceEncode: false,
			nativeVad: true,
			wakeword: false,
			classifiers: false,
			llmStream: false,
			llmCapability: false,
		},
		{
			defs: { ...coreDefs, ...referenceEncodeDefs },
			referenceEncode: true,
			nativeVad: false,
			wakeword: false,
			classifiers: false,
			llmStream: false,
			llmCapability: false,
		},
		{
			defs: coreDefs,
			referenceEncode: false,
			nativeVad: false,
			wakeword: false,
			classifiers: false,
			llmStream: false,
			llmCapability: false,
		},
	];
	let lastOpenError: unknown = null;
	for (const attempt of attempts) {
		try {
			lib = ffi.dlopen(dylibPath, attempt.defs);
			referenceEncodeSymbolsAvailable = attempt.referenceEncode;
			nativeVadSymbolsAvailable = attempt.nativeVad;
			wakewordSymbolsAvailable = attempt.wakeword;
			speakerSymbolsAvailable = attempt.classifiers;
			diarizSymbolsAvailable = attempt.classifiers;
			llmStreamSymbolsAvailable = attempt.llmStream;
			llmCapabilitySymbolsAvailable = attempt.llmCapability ?? false;
			textModalitiesSymbolsAvailable =
				(attempt as { textModalities?: boolean }).textModalities ?? false;
			kokoroSymbolsAvailable =
				(attempt as { kokoro?: boolean }).kokoro ?? false;
			kokoroG2pSymbolsAvailable =
				(attempt as { kokoroG2p?: boolean }).kokoroG2p ?? false;
			eotSymbolsAvailable = (attempt as { eot?: boolean }).eot ?? false;
			timedAsrSymbolsAvailable =
				(attempt as { timedAsr?: boolean }).timedAsr ?? false;
			visionStreamSymbolsAvailable =
				(attempt as { visionStream?: boolean }).visionStream ?? false;
			break;
		} catch (err) {
			lastOpenError = err;
		}
	}
	if (lib === null) {
		throw new VoiceLifecycleError(
			"kernel-missing",
			`[ffi-bindings] Failed to open libelizainference at ${dylibPath}: ${formatFfiError(lastOpenError)}`,
		);
	}
	const loadedLib = lib;

	// ABI version check. v4 is the current full surface; v3 is accepted only
	// when the optional reference-encode symbols are absent so default TTS/ASR
	// can still run while sample-to-profile freezing stays explicitly disabled.
	const reported = readCString(
		loadedLib.symbols.eliza_inference_abi_version(),
		ffi,
	);
	// v8 is the current full surface (v8 = streaming-LLM text parity: same-file
	// MTP speculative decoding + KV-cache quant + per-load GPU layers, probed
	// via `eliza_inference_llm_{mtp,kv_quant}_supported()`). A v7 library has
	// the identical voice/ASR/VAD symbol surface but lacks those LLM
	// optimizations, so it is still accepted for voice — the new capability
	// probes report unsupported, and the fused TEXT path refuses to route
	// through it (the anti-regression guard). Older fused builds may still be
	// useful at degraded capability:
	//   - v7: real Silero VAD; LLM-text optimizations absent (probed).
	//   - v6: same symbols as v7; VAD may be a stub (probed at runtime).
	//   - v5: no speaker/diarizer classifiers — JS reports them unsupported.
	//   - v4: additionally no wake-word — JS reports wake-word unsupported.
	//   - v3: additionally no reference-encode — accepted only when the
	//     optional reference-encode symbols are absent from the binding.
	// v10 (current) accepts the full surface. A v9 library has the identical
	// voice/ASR/VAD/LLM/text surface but lacks the v10 Kokoro symbols
	// (`eliza_inference_kokoro_*`), so it is accepted only when those symbols
	// are absent — the `kokoroSupported()` probe then reports false and the
	// Kokoro FFI runtime refuses (no TCP fallback on mobile). A v8 library
	// additionally lacks the v9 text-modality symbols (embeddings, vision,
	// tokenizer), accepted only when those are absent too.
	const abiOk =
		reported === String(ELIZA_INFERENCE_ABI_VERSION) ||
		(reported === "13" && !kokoroG2pSymbolsAvailable) ||
		(reported === "12" &&
			!kokoroG2pSymbolsAvailable &&
			!visionStreamSymbolsAvailable) ||
		(reported === "11" && !timedAsrSymbolsAvailable) ||
		(reported === "10" && !eotSymbolsAvailable && !timedAsrSymbolsAvailable) ||
		(reported === "9" && !kokoroSymbolsAvailable && !eotSymbolsAvailable) ||
		(reported === "8" &&
			!kokoroSymbolsAvailable &&
			!textModalitiesSymbolsAvailable) ||
		reported === "7" ||
		reported === "6" ||
		(reported === "5" && !speakerSymbolsAvailable && !diarizSymbolsAvailable) ||
		(reported === "4" &&
			!wakewordSymbolsAvailable &&
			!speakerSymbolsAvailable &&
			!diarizSymbolsAvailable) ||
		(reported === "3" &&
			!wakewordSymbolsAvailable &&
			!speakerSymbolsAvailable &&
			!diarizSymbolsAvailable &&
			!referenceEncodeSymbolsAvailable);
	if (!abiOk) {
		loadedLib.close();
		throw new VoiceLifecycleError(
			"kernel-missing",
			`[ffi-bindings] ABI mismatch: binding expected v${ELIZA_INFERENCE_ABI_VERSION}, ` +
				`library at ${dylibPath} reports v${reported}. The fused build was produced ` +
				`against a different ffi.h — rebuild against the current header.`,
		);
	}

	/**
	 * Read `*outErrPtr` (a `char**` that the library populated with a
	 * heap-allocated NUL-terminated string), free the underlying buffer
	 * via `eliza_inference_free_string`, and return the JS string. When
	 * the library left `*outErrPtr` as NULL, returns null.
	 */
	function takeError(outErrPtrBuf: BigUint64Array): string | null {
		const ptrValue = outErrPtrBuf[0];
		if (ptrValue === undefined || ptrValue === 0n) return null;
		const ptrNumber = Number(ptrValue);
		if (!Number.isSafeInteger(ptrNumber)) {
			throw new VoiceLifecycleError(
				"kernel-missing",
				`[ffi-bindings] C diagnostic pointer ${ptrValue.toString()} exceeds JS safe integer range`,
			);
		}
		const cstr = new ffi.CString(ptrNumber);
		const message = cstr.toString();
		loadedLib.symbols.eliza_inference_free_string(ptrValue);
		return message;
	}

	function makeOutErr(): { buf: BigUint64Array; ptr: unknown } {
		const buf = new BigUint64Array(1);
		return { buf, ptr: ffi.ptr(buf) };
	}

	/**
	 * Encode a JS string to a NUL-terminated UTF-8 buffer and return a
	 * `T.ptr`-compatible pointer suitable for `const char *` arguments.
	 * Returns null when the input is null — the C ABI accepts NULL for
	 * optional arguments like `speaker_preset_id`.
	 */
	function cstr(value: string | null): {
		ptr: unknown;
		bytes: number;
		buffer: Buffer | null;
	} {
		if (value === null) return { ptr: null, bytes: 0, buffer: null };
		const bytes = Buffer.from(value, "utf8");
		const buf = Buffer.alloc(bytes.byteLength + 1);
		bytes.copy(buf);
		return { ptr: ffi.ptr(buf), bytes: bytes.byteLength, buffer: buf };
	}

	function failureCode(rc: number): VoiceLifecycleError["code"] {
		if (rc === ELIZA_ERR_OOM) return "ram-pressure";
		if (rc === ELIZA_ERR_FFI_FAULT) return "mmap-fail";
		if (rc === ELIZA_ERR_NOT_IMPLEMENTED) return "kernel-missing";
		if (rc === ELIZA_ERR_ABI_MISMATCH) return "kernel-missing";
		if (rc === ELIZA_ERR_BUNDLE_INVALID) return "kernel-missing";
		return "kernel-missing";
	}

	function isNullPointer(value: unknown): boolean {
		return value === null || value === undefined || value === 0n || value === 0;
	}

	return {
		libraryPath: dylibPath,
		libraryAbiVersion: reported,

		create(bundleDir: string): ElizaInferenceContextHandle {
			const err = makeOutErr();
			const bundleArg = cstr(bundleDir);
			const handle = loadedLib.symbols.eliza_inference_create(
				bundleArg.ptr,
				err.ptr,
			);
			if (isNullPointer(handle)) {
				const message =
					takeError(err.buf) ??
					"[ffi-bindings] eliza_inference_create returned NULL with no diagnostic";
				throw new VoiceLifecycleError("kernel-missing", message);
			}
			return handle as ElizaInferenceContextHandle;
		},

		destroy(ctx: ElizaInferenceContextHandle): void {
			loadedLib.symbols.eliza_inference_destroy(ctx);
		},

		mmapAcquire(ctx, region) {
			const err = makeOutErr();
			const regionArg = cstr(region);
			const rc = loadedLib.symbols.eliza_inference_mmap_acquire(
				ctx,
				regionArg.ptr,
				err.ptr,
			);
			if (rc !== ELIZA_OK) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_mmap_acquire(${region}) rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
		},

		mmapEvict(ctx, region) {
			const err = makeOutErr();
			const regionArg = cstr(region);
			const rc = loadedLib.symbols.eliza_inference_mmap_evict(
				ctx,
				regionArg.ptr,
				err.ptr,
			);
			if (rc !== ELIZA_OK) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_mmap_evict(${region}) rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
		},

		ttsSynthesize({ ctx, text, speakerPresetId, out }) {
			const err = makeOutErr();
			const textArg = cstr(text);
			const speakerArg = cstr(speakerPresetId);
			const rc = loadedLib.symbols.eliza_inference_tts_synthesize(
				ctx,
				textArg.ptr,
				BigInt(textArg.bytes),
				speakerArg.ptr,
				ffi.ptr(out),
				BigInt(out.length),
				err.ptr,
			);
			if (rc < 0) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_tts_synthesize rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
			return rc;
		},

		asrTranscribe({ ctx, pcm, sampleRateHz, maxTextBytes }) {
			const err = makeOutErr();
			const cap = maxTextBytes ?? 4096;
			const outText = new Uint8Array(cap);
			const rc = loadedLib.symbols.eliza_inference_asr_transcribe(
				ctx,
				ffi.ptr(pcm),
				BigInt(pcm.length),
				sampleRateHz,
				ffi.ptr(outText),
				BigInt(cap),
				err.ptr,
			);
			if (rc < 0) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_asr_transcribe rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
			const nul = outText.indexOf(0, 0);
			const len = nul >= 0 ? nul : rc;
			return Buffer.from(outText.buffer, outText.byteOffset, len).toString(
				"utf8",
			);
		},

		timedAsrSupported(): boolean {
			const probe = loadedLib.symbols.eliza_inference_asr_timestamps_supported;
			return (
				timedAsrSymbolsAvailable && typeof probe === "function" && probe() === 1
			);
		},

		asrTranscribeTimed({ ctx, pcm, sampleRateHz, maxTextBytes, maxWords }) {
			const fn = loadedLib.symbols.eliza_inference_asr_transcribe_timed;
			if (!timedAsrSymbolsAvailable || typeof fn !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_asr_transcribe_timed is not exported by this build (pre-v12)",
				);
			}
			const err = makeOutErr();
			const cap = maxTextBytes ?? 4096;
			const wordCap = maxWords ?? 1024;
			const outText = new Uint8Array(cap);
			const startMs = new Int32Array(wordCap);
			const endMs = new Int32Array(wordCap);
			const nWords = new BigUint64Array(1);
			nWords[0] = BigInt(wordCap);
			const rc = fn(
				ctx,
				ffi.ptr(pcm),
				BigInt(pcm.length),
				sampleRateHz,
				ffi.ptr(outText),
				BigInt(cap),
				ffi.ptr(startMs),
				ffi.ptr(endMs),
				ffi.ptr(nWords),
				err.ptr,
			);
			if (rc < 0) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_asr_transcribe_timed rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
			const nul = outText.indexOf(0, 0);
			const len = nul >= 0 ? nul : rc;
			const text = Buffer.from(
				outText.buffer,
				outText.byteOffset,
				len,
			).toString("utf8");
			const words = recoverAsrWords(text, Number(nWords[0]), startMs, endMs);
			return { text, words };
		},

		/* ---- Streaming TTS + verifier callback (ABI v2) ------------ */

		ttsStreamSupported(): boolean {
			return loadedLib.symbols.eliza_inference_tts_stream_supported() === 1;
		},

		ttsSynthesizeStream({ ctx, text, speakerPresetId, onChunk }) {
			const err = makeOutErr();
			const textArg = cstr(text);
			const speakerArg = cstr(speakerPresetId);
			// (pcm: ptr, n_samples: usize, is_final: i32, user_data: ptr) -> i32
			const cb = new ffi.JSCallback(
				(pcmPtr: bigint, nSamples: bigint, isFinal: number) => {
					const n = Number(nSamples);
					// Bun delivers the C pointer as a bigint; copy the floats out
					// before returning — the buffer is the library's, valid only
					// for this call.
					const pcm =
						n > 0 && pcmPtr !== 0n
							? new Float32Array(ffi.toArrayBuffer(pcmPtr, 0, n * 4).slice(0))
							: new Float32Array(0);
					const requestCancel = onChunk({ pcm, isFinal: isFinal !== 0 });
					return requestCancel === true ? 1 : 0;
				},
				{
					args: [T.ptr, T.usize, T.i32, T.ptr],
					returns: T.i32,
				},
			);
			try {
				const rc = loadedLib.symbols.eliza_inference_tts_synthesize_stream(
					ctx,
					textArg.ptr,
					BigInt(textArg.bytes),
					speakerArg.ptr,
					BigInt(cb.ptr),
					0n,
					err.ptr,
				);
				if (rc === ELIZA_ERR_CANCELLED) return { cancelled: true };
				if (rc < 0) {
					const message =
						takeError(err.buf) ??
						`[ffi-bindings] eliza_inference_tts_synthesize_stream rc=${rc}`;
					throw new VoiceLifecycleError(failureCode(rc), message);
				}
				return { cancelled: false };
			} finally {
				cb.close();
			}
		},

		cancelTts(ctx) {
			const err = makeOutErr();
			const rc = loadedLib.symbols.eliza_inference_cancel_tts(ctx, err.ptr);
			if (rc !== ELIZA_OK) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_cancel_tts rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
		},

		encodeReferenceSupported(): boolean {
			return (
				typeof loadedLib.symbols.eliza_inference_encode_reference === "function"
			);
		},

		encodeReference({ ctx, pcm, sampleRateHz }) {
			if (
				typeof loadedLib.symbols.eliza_inference_encode_reference !==
					"function" ||
				typeof loadedLib.symbols.eliza_inference_free_tokens !== "function"
			) {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_encode_reference is not exported by this build",
				);
			}
			if (sampleRateHz !== 24000) {
				throw new VoiceLifecycleError(
					"kernel-missing",
					`[ffi-bindings] encodeReference: sampleRateHz must be 24000 (got ${sampleRateHz})`,
				);
			}
			const err = makeOutErr();
			// out_K and out_ref_T are int*, out_tokens is int** — give the library
			// a slot to write into, then read back.
			const outK = new Int32Array(1);
			const outRefT = new Int32Array(1);
			const outTokensPtr = new BigUint64Array(1);
			const rc = loadedLib.symbols.eliza_inference_encode_reference(
				ctx,
				ffi.ptr(pcm),
				BigInt(pcm.length),
				sampleRateHz,
				ffi.ptr(outK),
				ffi.ptr(outRefT),
				ffi.ptr(outTokensPtr),
				err.ptr,
			);
			if (rc !== ELIZA_OK) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_encode_reference rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
			const K = outK[0];
			const refT = outRefT[0];
			const tokensRaw = outTokensPtr[0];
			if (K <= 0 || refT <= 0 || tokensRaw === 0n) {
				throw new VoiceLifecycleError(
					"kernel-missing",
					`[ffi-bindings] encodeReference returned empty result (K=${K}, refT=${refT})`,
				);
			}
			const tokenCount = K * refT;
			try {
				// Copy out of the library's malloc'ed buffer so we can free it
				// before returning. Each int32 is 4 bytes.
				const tokenBytes = tokenCount * 4;
				const tokensPtr =
					typeof tokensRaw === "bigint" ? Number(tokensRaw) : tokensRaw;
				const nativeView = ffi.toArrayBuffer(tokensPtr, 0, tokenBytes);
				const bytes = new Uint8Array(nativeView);
				if (bytes.byteLength < tokenBytes) {
					throw new VoiceLifecycleError(
						"kernel-missing",
						`[ffi-bindings] encodeReference returned an unreadable token buffer (K=${K}, refT=${refT}, got=${bytes.byteLength}, expected=${tokenBytes}, ctor=${nativeView.constructor.name})`,
					);
				}
				const copied = bytes.slice(0, tokenBytes);
				const tokens = new Int32Array(copied.buffer);
				return { K, refT, tokens };
			} finally {
				loadedLib.symbols.eliza_inference_free_tokens(tokensRaw);
			}
		},

		setVerifierCallback(ctx, cbFn) {
			const err = makeOutErr();
			if (cbFn === null) {
				const rc = loadedLib.symbols.eliza_inference_set_verifier_callback(
					ctx,
					0n,
					0n,
					err.ptr,
				);
				if (rc !== ELIZA_OK) {
					const message =
						takeError(err.buf) ??
						`[ffi-bindings] eliza_inference_set_verifier_callback(clear) rc=${rc}`;
					throw new VoiceLifecycleError(failureCode(rc), message);
				}
				return { close: () => {} };
			}
			// (ev: ptr to EliVerifierEvent, user_data: ptr) -> void
			const cb = new ffi.JSCallback(
				(evPtr: bigint) => {
					cbFn(readVerifierEvent(evPtr, ffi));
				},
				{ args: [T.ptr, T.ptr], returns: T.void },
			);
			const rc = loadedLib.symbols.eliza_inference_set_verifier_callback(
				ctx,
				BigInt(cb.ptr),
				0n,
				err.ptr,
			);
			if (rc !== ELIZA_OK) {
				cb.close();
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_set_verifier_callback rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
			return {
				close: () => {
					// Clear the native registration FIRST, then free the
					// JSCallback — order matters so the native side never
					// dereferences a closed callback.
					const clearErr = makeOutErr();
					loadedLib.symbols.eliza_inference_set_verifier_callback(
						ctx,
						0n,
						0n,
						clearErr.ptr,
					);
					takeError(clearErr.buf);
					cb.close();
				},
			};
		},

		/* ---- Native VAD (ABI v3) ----------------------------------- */

		vadSupported(): boolean {
			if (
				!nativeVadSymbolsAvailable ||
				typeof loadedLib.symbols.eliza_inference_vad_supported !== "function"
			) {
				return false;
			}
			return loadedLib.symbols.eliza_inference_vad_supported() === 1;
		},

		vadOpen({ ctx, sampleRateHz }) {
			const open = loadedLib.symbols.eliza_inference_vad_open;
			if (!nativeVadSymbolsAvailable || typeof open !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_vad_open is not exported by this libelizainference build",
				);
			}
			const err = makeOutErr();
			const handle = open(ctx, sampleRateHz, err.ptr);
			if (isNullPointer(handle)) {
				const message =
					takeError(err.buf) ??
					"[ffi-bindings] eliza_inference_vad_open returned NULL with no diagnostic";
				throw new VoiceLifecycleError("kernel-missing", message);
			}
			return handle as NativeVadHandle;
		},

		vadProcess({ vad, pcm }) {
			const process = loadedLib.symbols.eliza_inference_vad_process;
			if (!nativeVadSymbolsAvailable || typeof process !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_vad_process is not exported by this libelizainference build",
				);
			}
			const err = makeOutErr();
			const outProbability = new Float32Array(1);
			const rc = process(
				vad,
				ffi.ptr(pcm),
				BigInt(pcm.length),
				ffi.ptr(outProbability),
				err.ptr,
			);
			if (rc !== ELIZA_OK) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_vad_process rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
			return outProbability[0] ?? 0;
		},

		vadReset(vad) {
			const reset = loadedLib.symbols.eliza_inference_vad_reset;
			if (!nativeVadSymbolsAvailable || typeof reset !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_vad_reset is not exported by this libelizainference build",
				);
			}
			const err = makeOutErr();
			const rc = reset(vad, err.ptr);
			if (rc !== ELIZA_OK) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_vad_reset rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
		},

		vadClose(vad) {
			loadedLib.symbols.eliza_inference_vad_close?.(vad);
		},

		/* ---- Native wake-word (ABI v5) ----------------------------- */

		wakewordSupported(): boolean {
			if (
				!wakewordSymbolsAvailable ||
				typeof loadedLib.symbols.eliza_inference_wakeword_supported !==
					"function"
			) {
				return false;
			}
			return loadedLib.symbols.eliza_inference_wakeword_supported() === 1;
		},

		wakewordOpen({ ctx, sampleRateHz, headName }) {
			const open = loadedLib.symbols.eliza_inference_wakeword_open;
			if (!wakewordSymbolsAvailable || typeof open !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_wakeword_open is not exported by this libelizainference build (wake-word GGUF runtime not present)",
				);
			}
			const err = makeOutErr();
			const headArg = cstr(headName);
			const handle = open(ctx, sampleRateHz, headArg.ptr, err.ptr);
			if (isNullPointer(handle)) {
				const message =
					takeError(err.buf) ??
					"[ffi-bindings] eliza_inference_wakeword_open returned NULL with no diagnostic";
				throw new VoiceLifecycleError("kernel-missing", message);
			}
			return handle as NativeWakeWordHandle;
		},

		wakewordScore({ wake, pcm }) {
			const score = loadedLib.symbols.eliza_inference_wakeword_score;
			if (!wakewordSymbolsAvailable || typeof score !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_wakeword_score is not exported by this libelizainference build",
				);
			}
			const err = makeOutErr();
			const outProbability = new Float32Array(1);
			const rc = score(
				wake,
				ffi.ptr(pcm),
				BigInt(pcm.length),
				ffi.ptr(outProbability),
				err.ptr,
			);
			if (rc !== ELIZA_OK) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_wakeword_score rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
			return outProbability[0] ?? 0;
		},

		wakewordReset(wake) {
			const reset = loadedLib.symbols.eliza_inference_wakeword_reset;
			if (!wakewordSymbolsAvailable || typeof reset !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_wakeword_reset is not exported by this libelizainference build",
				);
			}
			const err = makeOutErr();
			const rc = reset(wake, err.ptr);
			if (rc !== ELIZA_OK) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_wakeword_reset rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
		},

		wakewordClose(wake) {
			loadedLib.symbols.eliza_inference_wakeword_close?.(wake);
		},

		/* ---- Native speaker encoder (ABI v6) ----------------------- */

		speakerSupported(): boolean {
			if (
				!speakerSymbolsAvailable ||
				typeof loadedLib.symbols.eliza_inference_speaker_supported !==
					"function"
			) {
				return false;
			}
			return loadedLib.symbols.eliza_inference_speaker_supported() === 1;
		},

		speakerOpen({ ctx, ggufPath }) {
			const open = loadedLib.symbols.eliza_inference_speaker_open;
			if (!speakerSymbolsAvailable || typeof open !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_speaker_open is not exported by this libelizainference build",
				);
			}
			const err = makeOutErr();
			const ggufArg = cstr(ggufPath);
			const handle = open(ctx, ggufArg.ptr, err.ptr);
			if (isNullPointer(handle)) {
				const message =
					takeError(err.buf) ??
					"[ffi-bindings] eliza_inference_speaker_open returned NULL with no diagnostic";
				throw new VoiceLifecycleError("kernel-missing", message);
			}
			return handle as NativeSpeakerHandle;
		},

		speakerEmbed({ speaker, pcm }) {
			const embed = loadedLib.symbols.eliza_inference_speaker_embed;
			if (!speakerSymbolsAvailable || typeof embed !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_speaker_embed is not exported by this libelizainference build",
				);
			}
			const err = makeOutErr();
			const outEmbedding = new Float32Array(SPEAKER_EMBEDDING_DIM);
			const rc = embed(
				speaker,
				ffi.ptr(pcm),
				BigInt(pcm.length),
				ffi.ptr(outEmbedding),
				err.ptr,
			);
			if (rc !== ELIZA_OK) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_speaker_embed rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
			return outEmbedding;
		},

		speakerClose(speaker) {
			loadedLib.symbols.eliza_inference_speaker_close?.(speaker);
		},

		/* ---- Native diarizer (ABI v6) ------------------------------ */

		diarizSupported(): boolean {
			if (
				!diarizSymbolsAvailable ||
				typeof loadedLib.symbols.eliza_inference_diariz_supported !== "function"
			) {
				return false;
			}
			return loadedLib.symbols.eliza_inference_diariz_supported() === 1;
		},

		diarizOpen({ ctx, ggufPath }) {
			const open = loadedLib.symbols.eliza_inference_diariz_open;
			if (!diarizSymbolsAvailable || typeof open !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_diariz_open is not exported by this libelizainference build",
				);
			}
			const err = makeOutErr();
			const ggufArg = cstr(ggufPath);
			const handle = open(ctx, ggufArg.ptr, err.ptr);
			if (isNullPointer(handle)) {
				const message =
					takeError(err.buf) ??
					"[ffi-bindings] eliza_inference_diariz_open returned NULL with no diagnostic";
				throw new VoiceLifecycleError("kernel-missing", message);
			}
			return handle as NativeDiarizHandle;
		},

		diarizSegment({ diariz, pcm }) {
			const segment = loadedLib.symbols.eliza_inference_diariz_segment;
			if (!diarizSymbolsAvailable || typeof segment !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_diariz_segment is not exported by this libelizainference build",
				);
			}
			const err = makeOutErr();
			// The library writes `frames_per_window` (293 for pyannote-3) int8
			// labels. Pass a generous capacity and read back the actual count
			// the library writes into `*io_n_labels`.
			const outLabels = new Int8Array(DIARIZ_LABELS_CAPACITY);
			const ioNLabels = new BigUint64Array([BigInt(outLabels.length)]);
			const rc = segment(
				diariz,
				ffi.ptr(pcm),
				BigInt(pcm.length),
				ffi.ptr(outLabels),
				ffi.ptr(ioNLabels),
				err.ptr,
			);
			if (rc !== ELIZA_OK) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_diariz_segment rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
			const nFrames = Number(ioNLabels[0] ?? 0n);
			return outLabels.slice(0, Math.min(nFrames, outLabels.length));
		},

		diarizClose(diariz) {
			loadedLib.symbols.eliza_inference_diariz_close?.(diariz);
		},

		/* ---- Streaming ASR (ABI v2) -------------------------------- */

		asrStreamSupported(): boolean {
			return loadedLib.symbols.eliza_inference_asr_stream_supported() === 1;
		},

		asrStreamOpen({ ctx, sampleRateHz }) {
			const err = makeOutErr();
			const handle = loadedLib.symbols.eliza_inference_asr_stream_open(
				ctx,
				sampleRateHz,
				err.ptr,
			);
			if (isNullPointer(handle)) {
				const message =
					takeError(err.buf) ??
					"[ffi-bindings] eliza_inference_asr_stream_open returned NULL with no diagnostic";
				throw new VoiceLifecycleError("kernel-missing", message);
			}
			return handle as bigint;
		},

		asrStreamFeed({ stream, pcm }) {
			const err = makeOutErr();
			const rc = loadedLib.symbols.eliza_inference_asr_stream_feed(
				stream,
				ffi.ptr(pcm),
				BigInt(pcm.length),
				err.ptr,
			);
			if (rc < 0) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_asr_stream_feed rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
		},

		asrStreamPartial(args) {
			return readAsrStreamResult(
				"partial",
				loadedLib.symbols.eliza_inference_asr_stream_partial,
				args,
			);
		},

		asrStreamFinish(args) {
			return readAsrStreamResult(
				"finish",
				loadedLib.symbols.eliza_inference_asr_stream_finish,
				args,
			);
		},

		asrStreamClose(stream) {
			loadedLib.symbols.eliza_inference_asr_stream_close(stream);
		},

		/* ---- Streaming LLM (additive on top of v3) ----------------- */

		llmStreamSupported(): boolean {
			// Symbols are bound at dlopen — if the fallback path stripped them
			// out, the runtime never advertises support.
			return (
				llmStreamSymbolsAvailable &&
				typeof loadedLib.symbols.eliza_inference_llm_stream_open === "function"
			);
		},

		llmMtpSupported(): boolean {
			// ABI v8 capability probe. Absent (or the whole probe family
			// unbound) on a v7 library → unsupported, so the fused text path
			// refuses to route MTP through it.
			const probe = loadedLib.symbols.eliza_inference_llm_mtp_supported;
			return (
				llmCapabilitySymbolsAvailable &&
				typeof probe === "function" &&
				probe() === 1
			);
		},

		llmKvQuantSupported(): boolean {
			const probe = loadedLib.symbols.eliza_inference_llm_kv_quant_supported;
			return (
				llmCapabilitySymbolsAvailable &&
				typeof probe === "function" &&
				probe() === 1
			);
		},

		llmStreamOpen({ ctx, config }) {
			const open = loadedLib.symbols.eliza_inference_llm_stream_open;
			if (!llmStreamSymbolsAvailable || typeof open !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_llm_stream_open is not exported by this build",
				);
			}
			const err = makeOutErr();
			// Marshal the config struct into a Buffer. Layout matches
			// `eliza_llm_stream_config_t` in `eliza-inference-ffi.h`
			// (8-byte aligned, ABI v9):
			//   off  0 : i32  max_tokens
			//   off  4 : f32  temperature
			//   off  8 : f32  top_p
			//   off 12 : i32  top_k
			//   off 16 : f32  repeat_penalty
			//   off 20 : i32  slot_id
			//   off 24 : ptr  prompt_cache_key
			//   off 32 : i32  draft_min
			//   off 36 : i32  draft_max
			//   off 40 : ptr  mtp_drafter_path
			//   off 48 : ptr  gbnf_grammar
			//   off 56 : i32  disable_thinking
			//   off 60 : i32  n_gpu_layers          (ABI v8 — fills old tail pad)
			//   off 64 : ptr  cache_type_k          (ABI v8)
			//   off 72 : ptr  cache_type_v          (ABI v8)
			//   off 80 : i32  context_size          (ABI v9)
			//   sizeof = 88
			const buf = Buffer.alloc(88);
			buf.writeInt32LE(config.maxTokens, 0);
			buf.writeFloatLE(config.temperature, 4);
			buf.writeFloatLE(config.topP, 8);
			buf.writeInt32LE(config.topK, 12);
			buf.writeFloatLE(config.repeatPenalty, 16);
			buf.writeInt32LE(config.slotId, 20);
			const keyArg = cstr(config.promptCacheKey);
			const drafterArg = cstr(config.draftModelPath);
			const grammarArg = cstr(
				config.gbnfGrammar && config.gbnfGrammar.length > 0
					? config.gbnfGrammar
					: null,
			);
			const cacheKArg = cstr(
				config.cacheTypeK && config.cacheTypeK.length > 0
					? config.cacheTypeK
					: null,
			);
			const cacheVArg = cstr(
				config.cacheTypeV && config.cacheTypeV.length > 0
					? config.cacheTypeV
					: null,
			);
			buf.writeBigUInt64LE(toPtrBigInt(keyArg.ptr), 24);
			buf.writeInt32LE(config.draftMin, 32);
			buf.writeInt32LE(config.draftMax, 36);
			buf.writeBigUInt64LE(toPtrBigInt(drafterArg.ptr), 40);
			buf.writeBigUInt64LE(toPtrBigInt(grammarArg.ptr), 48);
			buf.writeInt32LE(config.disableThinking ? 1 : 0, 56);
			// -1 = runtime default (all layers); 0 = CPU. `undefined` -> -1.
			buf.writeInt32LE(
				config.gpuLayers === undefined ? -1 : config.gpuLayers,
				60,
			);
			buf.writeBigUInt64LE(toPtrBigInt(cacheKArg.ptr), 64);
			buf.writeBigUInt64LE(toPtrBigInt(cacheVArg.ptr), 72);
			buf.writeInt32LE(config.contextSize ?? 0, 80);
			const handle = open(ctx, ffi.ptr(buf), err.ptr);
			if (isNullPointer(handle)) {
				const message =
					takeError(err.buf) ??
					"[ffi-bindings] eliza_inference_llm_stream_open returned NULL with no diagnostic";
				throw new VoiceLifecycleError("kernel-missing", message);
			}
			return handle as LlmStreamHandle;
		},

		llmStreamPrefill({ stream, tokens }) {
			const prefill = loadedLib.symbols.eliza_inference_llm_stream_prefill;
			if (!llmStreamSymbolsAvailable || typeof prefill !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_llm_stream_prefill is not exported by this build",
				);
			}
			const err = makeOutErr();
			const rc = prefill(
				stream,
				ffi.ptr(tokens),
				BigInt(tokens.length),
				err.ptr,
			);
			if (rc !== ELIZA_OK) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_llm_stream_prefill rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
		},

		llmStreamNext({ stream, maxTokensPerStep, maxTextBytes }) {
			const next = loadedLib.symbols.eliza_inference_llm_stream_next;
			if (!llmStreamSymbolsAvailable || typeof next !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_llm_stream_next is not exported by this build",
				);
			}
			const err = makeOutErr();
			const tokenCap = maxTokensPerStep ?? 32;
			const textCap = maxTextBytes ?? 1024;
			const tokensOut = new Int32Array(tokenCap);
			const numTokensOut = new BigUint64Array(1);
			const textOut = new Uint8Array(textCap);
			const drafterDrafted = new Int32Array(1);
			const drafterAccepted = new Int32Array(1);
			const rc = next(
				stream,
				ffi.ptr(tokensOut),
				BigInt(tokenCap),
				ffi.ptr(numTokensOut),
				ffi.ptr(textOut),
				BigInt(textCap),
				ffi.ptr(drafterDrafted),
				ffi.ptr(drafterAccepted),
				err.ptr,
			);
			if (rc < 0) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_llm_stream_next rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
			const n = Number(numTokensOut[0] ?? 0n);
			const tokens = Array.from(tokensOut.subarray(0, Math.min(n, tokenCap)));
			const nul = textOut.indexOf(0, 0);
			const len = nul >= 0 ? nul : textCap;
			const text = Buffer.from(
				textOut.buffer,
				textOut.byteOffset,
				len,
			).toString("utf8");
			return {
				tokens,
				text,
				done: rc === 1,
				drafterDrafted: drafterDrafted[0] ?? 0,
				drafterAccepted: drafterAccepted[0] ?? 0,
			};
		},

		llmStreamCancel(stream) {
			const cancel = loadedLib.symbols.eliza_inference_llm_stream_cancel;
			if (!llmStreamSymbolsAvailable || typeof cancel !== "function") {
				// Cancel is best-effort — a build without the symbol just means
				// the runtime cannot interrupt mid-step. The next `_next` call
				// will still finish normally; the caller drops the result.
				return;
			}
			cancel(stream);
		},

		llmStreamSaveSlot({ stream, filename }) {
			const save = loadedLib.symbols.eliza_inference_llm_stream_save_slot;
			if (!llmStreamSymbolsAvailable || typeof save !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_llm_stream_save_slot is not exported by this build",
				);
			}
			const err = makeOutErr();
			const fnameArg = cstr(filename);
			const rc = save(stream, fnameArg.ptr, err.ptr);
			if (rc !== ELIZA_OK) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_llm_stream_save_slot rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
		},

		llmStreamRestoreSlot({ stream, filename }) {
			const restore = loadedLib.symbols.eliza_inference_llm_stream_restore_slot;
			if (!llmStreamSymbolsAvailable || typeof restore !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_llm_stream_restore_slot is not exported by this build",
				);
			}
			const err = makeOutErr();
			const fnameArg = cstr(filename);
			const rc = restore(stream, fnameArg.ptr, err.ptr);
			if (rc !== ELIZA_OK) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_llm_stream_restore_slot rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
		},

		llmStreamClose(stream) {
			loadedLib.symbols.eliza_inference_llm_stream_close?.(stream);
		},

		/* ---- Text embeddings (ABI v9) ------------------------------ */

		embedSupported(): boolean {
			const probe = loadedLib.symbols.eliza_inference_embed_supported;
			return (
				textModalitiesSymbolsAvailable &&
				typeof probe === "function" &&
				probe() === 1
			);
		},

		embed({ ctx, text, pooling }) {
			const embed = loadedLib.symbols.eliza_inference_embed;
			if (!textModalitiesSymbolsAvailable || typeof embed !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_embed is not exported by this build",
				);
			}
			const err = makeOutErr();
			const textArg = cstr(text);
			// The C side caps the write at n_embd. Hand it a generous buffer (the
			// largest dedicated-embedding dim we ship is 1024; 4096 covers any
			// decoder-as-embedder n_embd) and read back *out_dim for the real
			// length.
			const cap = 4096;
			const outEmbedding = new Float32Array(cap);
			const outDim = new Int32Array(1);
			const rc = embed(
				ctx,
				textArg.ptr,
				BigInt(textArg.bytes),
				pooling ?? ELIZA_POOLING_MEAN,
				ffi.ptr(outEmbedding),
				BigInt(cap),
				ffi.ptr(outDim),
				err.ptr,
			);
			if (rc !== ELIZA_OK) {
				const message =
					takeError(err.buf) ?? `[ffi-bindings] eliza_inference_embed rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
			const dim = outDim[0] ?? 0;
			if (dim <= 0 || dim > cap) {
				throw new VoiceLifecycleError(
					"kernel-missing",
					`[ffi-bindings] eliza_inference_embed returned out-of-range n_embd=${dim}`,
				);
			}
			return outEmbedding.slice(0, dim);
		},

		/* ---- mmproj vision describe (ABI v9) ----------------------- */

		visionSupported(): boolean {
			const probe = loadedLib.symbols.eliza_inference_vision_supported;
			return (
				textModalitiesSymbolsAvailable &&
				typeof probe === "function" &&
				probe() === 1
			);
		},

		describeImage({ ctx, imageBytes, mmprojPath, prompt, maxTextBytes }) {
			const describe = loadedLib.symbols.eliza_inference_describe_image;
			if (!textModalitiesSymbolsAvailable || typeof describe !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_describe_image is not exported by this build",
				);
			}
			const err = makeOutErr();
			const cap = maxTextBytes ?? 4096;
			const outText = new Uint8Array(cap);
			const mmprojArg = cstr(mmprojPath);
			const promptArg = cstr(prompt ?? null);
			const rc = describe(
				ctx,
				ffi.ptr(imageBytes),
				BigInt(imageBytes.length),
				mmprojArg.ptr,
				promptArg.ptr,
				ffi.ptr(outText),
				BigInt(cap),
				err.ptr,
			);
			if (rc < 0) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_describe_image rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
			const nul = outText.indexOf(0, 0);
			const len = nul >= 0 ? nul : rc;
			return Buffer.from(outText.buffer, outText.byteOffset, len).toString(
				"utf8",
			);
		},

		/* ---- Streaming mmproj vision describe (ABI v13) ------------ */

		visionStreamSupported(): boolean {
			const probe = loadedLib.symbols.eliza_inference_vision_stream_supported;
			return (
				visionStreamSymbolsAvailable &&
				typeof probe === "function" &&
				probe() === 1
			);
		},

		describeImageStreamOpen({ ctx, imageBytes, mmprojPath, prompt }) {
			const open = loadedLib.symbols.eliza_inference_describe_image_stream_open;
			if (!visionStreamSymbolsAvailable || typeof open !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_describe_image_stream_open is not exported by this build",
				);
			}
			const err = makeOutErr();
			const mmprojArg = cstr(mmprojPath);
			const promptArg = cstr(prompt ?? null);
			const handle = open(
				ctx,
				ffi.ptr(imageBytes),
				BigInt(imageBytes.length),
				mmprojArg.ptr,
				promptArg.ptr,
				err.ptr,
			);
			if (isNullPointer(handle)) {
				const message =
					takeError(err.buf) ??
					"[ffi-bindings] eliza_inference_describe_image_stream_open returned NULL with no diagnostic";
				throw new VoiceLifecycleError("kernel-missing", message);
			}
			return handle as LlmStreamHandle;
		},

		/* ---- Tokenizer (ABI v9) ------------------------------------ */

		tokenizeSupported(): boolean {
			const probe = loadedLib.symbols.eliza_inference_tokenize_supported;
			return (
				textModalitiesSymbolsAvailable &&
				typeof probe === "function" &&
				probe() === 1
			);
		},

		tokenize({ ctx, text, addSpecial, parseSpecial }) {
			const tokenize = loadedLib.symbols.eliza_inference_tokenize;
			const freeTokens = loadedLib.symbols.eliza_inference_free_tokens;
			if (
				!textModalitiesSymbolsAvailable ||
				typeof tokenize !== "function" ||
				typeof freeTokens !== "function"
			) {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_tokenize is not exported by this build",
				);
			}
			const err = makeOutErr();
			const textArg = cstr(text);
			// out_tokens is int** — give the library a slot to write the malloc'ed
			// pointer into, plus a size_t out for the count.
			const outTokensPtr = new BigUint64Array(1);
			const outN = new BigUint64Array(1);
			const rc = tokenize(
				ctx,
				textArg.ptr,
				BigInt(textArg.bytes),
				addSpecial === false ? 0 : 1,
				parseSpecial === true ? 1 : 0,
				ffi.ptr(outTokensPtr),
				ffi.ptr(outN),
				err.ptr,
			);
			if (rc !== ELIZA_OK) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_tokenize rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
			const n = Number(outN[0] ?? 0n);
			const tokensRaw = outTokensPtr[0] ?? 0n;
			if (n === 0) {
				// Empty token sequence — the library still returns a non-NULL
				// 1-byte buffer to free.
				if (tokensRaw !== 0n) freeTokens(tokensRaw);
				return new Int32Array(0);
			}
			try {
				const tokenBytes = n * 4;
				const tokensPtr =
					typeof tokensRaw === "bigint" ? Number(tokensRaw) : tokensRaw;
				const view = ffi.toArrayBuffer(tokensPtr, 0, tokenBytes);
				// Copy out of the library's malloc'ed buffer before freeing.
				return new Int32Array(new Uint8Array(view).slice(0, tokenBytes).buffer);
			} finally {
				freeTokens(tokensRaw);
			}
		},

		detokenize({ ctx, tokens, removeSpecial, unparseSpecial, maxTextBytes }) {
			const detokenize = loadedLib.symbols.eliza_inference_detokenize;
			if (!textModalitiesSymbolsAvailable || typeof detokenize !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_detokenize is not exported by this build",
				);
			}
			const err = makeOutErr();
			const cap = maxTextBytes ?? 4096;
			const outText = new Uint8Array(cap);
			const rc = detokenize(
				ctx,
				ffi.ptr(tokens),
				BigInt(tokens.length),
				removeSpecial === true ? 1 : 0,
				unparseSpecial === true ? 1 : 0,
				ffi.ptr(outText),
				BigInt(cap),
				err.ptr,
			);
			if (rc < 0) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_detokenize rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
			const nul = outText.indexOf(0, 0);
			const len = nul >= 0 ? nul : rc;
			return Buffer.from(outText.buffer, outText.byteOffset, len).toString(
				"utf8",
			);
		},

		/* ---- End-of-turn scoring (ABI v11) ------------------------- */

		eotSupported(): boolean {
			const probe = loadedLib.symbols.eliza_inference_llm_eot_supported;
			return (
				eotSymbolsAvailable && typeof probe === "function" && probe() === 1
			);
		},

		eotScore({ ctx, tokens, targetTokenId }) {
			const score = loadedLib.symbols.eliza_inference_llm_eot_score;
			if (!eotSymbolsAvailable || typeof score !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_llm_eot_score is not exported by this build (pre-v11)",
				);
			}
			if (tokens.length === 0) {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_llm_eot_score requires a non-empty token sequence",
				);
			}
			const err = makeOutErr();
			const outTargetProb = new Float32Array(1);
			const outTopToken = new Int32Array(1);
			const outTopProb = new Float32Array(1);
			const rc = score(
				ctx,
				ffi.ptr(tokens),
				BigInt(tokens.length),
				targetTokenId,
				ffi.ptr(outTargetProb),
				ffi.ptr(outTopToken),
				ffi.ptr(outTopProb),
				err.ptr,
			);
			if (rc !== ELIZA_OK) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_llm_eot_score rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
			return {
				targetProb: outTargetProb[0] ?? 0,
				topToken: outTopToken[0] ?? -1,
				topProb: outTopProb[0] ?? 0,
			};
		},

		/* ---- Kokoro TTS (ABI v10) ---------------------------------- */

		kokoroSupported(): boolean {
			const probe = loadedLib.symbols.eliza_inference_kokoro_supported;
			return (
				kokoroSymbolsAvailable && typeof probe === "function" && probe() === 1
			);
		},

		kokoroLoad({ ctx, ggufPath, voiceBinPath, styleDim }) {
			const load = loadedLib.symbols.eliza_inference_kokoro_load;
			if (!kokoroSymbolsAvailable || typeof load !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_kokoro_load is not exported by this build (pre-v10; Eliza-1 Kokoro engine not linked)",
				);
			}
			const err = makeOutErr();
			const ggufArg = cstr(ggufPath);
			const voiceArg = cstr(voiceBinPath);
			const rc = load(ctx, ggufArg.ptr, voiceArg.ptr, styleDim ?? 256, err.ptr);
			if (rc !== ELIZA_OK) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_kokoro_load rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
		},

		kokoroSynthesize({ ctx, text, speed, maxSamples }) {
			const synth = loadedLib.symbols.eliza_inference_kokoro_synthesize;
			if (!kokoroSymbolsAvailable || typeof synth !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_kokoro_synthesize is not exported by this build",
				);
			}
			const err = makeOutErr();
			const textArg = cstr(text);
			const outPcm = new Float32Array(maxSamples);
			const rc = synth(
				ctx,
				textArg.ptr,
				BigInt(textArg.bytes),
				speed ?? 1.0,
				ffi.ptr(outPcm),
				BigInt(maxSamples),
				err.ptr,
			);
			if (rc < 0) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_kokoro_synthesize rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
			return outPcm.slice(0, Math.min(rc, maxSamples));
		},

		kokoroSampleRate(ctx): number {
			const rate = loadedLib.symbols.eliza_inference_kokoro_sample_rate;
			if (!kokoroSymbolsAvailable || typeof rate !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_kokoro_sample_rate is not exported by this build",
				);
			}
			const rc = rate(ctx);
			if (rc < 0) {
				throw new VoiceLifecycleError(
					failureCode(rc),
					`[ffi-bindings] eliza_inference_kokoro_sample_rate rc=${rc} (no Kokoro model loaded on this ctx)`,
				);
			}
			return rc;
		},

		/* ---- Kokoro IPA input + G2P-kind (ABI v14) ----------------- */

		kokoroG2pKind(ctx): "espeak" | "ascii" | "unknown" {
			const fn = loadedLib.symbols.eliza_inference_kokoro_g2p_kind;
			if (!kokoroG2pSymbolsAvailable || typeof fn !== "function") {
				return "unknown";
			}
			const rc = fn(ctx);
			if (rc === ELIZA_KOKORO_G2P_ESPEAK) return "espeak";
			if (rc === ELIZA_KOKORO_G2P_ASCII) return "ascii";
			// Negative rc = non-Kokoro build; the kokoroSupported() probe already
			// gates that upstream, so treat any other value as unknown.
			return "unknown";
		},

		kokoroSynthesizeIpa({ ctx, ipa, speed, maxSamples }) {
			const synth = loadedLib.symbols.eliza_inference_kokoro_synthesize_ipa;
			if (!kokoroG2pSymbolsAvailable || typeof synth !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_kokoro_synthesize_ipa is not exported by this build (pre-v14)",
				);
			}
			const err = makeOutErr();
			const ipaArg = cstr(ipa);
			const outPcm = new Float32Array(maxSamples);
			const rc = synth(
				ctx,
				ipaArg.ptr,
				BigInt(ipaArg.bytes),
				speed ?? 1.0,
				ffi.ptr(outPcm),
				BigInt(maxSamples),
				err.ptr,
			);
			if (rc < 0) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_kokoro_synthesize_ipa rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
			return outPcm.slice(0, Math.min(rc, maxSamples));
		},

		close(): void {
			loadedLib.close();
		},
	};

	/**
	 * Convert a Bun-FFI pointer value (`unknown` per the lazy types) to the
	 * bigint the marshalled config struct stores in its `const char *`
	 * slots. NULL inputs translate to `0n`. Used by `llmStreamOpen` to
	 * inline the cstr pointers into the config buffer.
	 */
	function toPtrBigInt(value: unknown): bigint {
		if (value === null || value === undefined) return 0n;
		if (typeof value === "bigint") return value;
		if (typeof value === "number") return BigInt(value);
		// Bun returns its internal pointer object that coerces to bigint.
		return BigInt(value as number);
	}

	/**
	 * Shared body for `asr_stream_partial` / `asr_stream_finish` — both
	 * have the same 6-arg shape (`stream, out_text, max_text_bytes,
	 * out_tokens, io_n_tokens, out_error`). Token ids are read only when
	 * the caller asks for them (`maxTokens > 0`); otherwise the
	 * out_tokens / io_n_tokens pointers are NULL.
	 */
	function readAsrStreamResult(
		label: string,
		fn: (
			stream: bigint,
			outText: unknown,
			maxTextBytes: bigint | number,
			outTokens: unknown,
			ioNTokens: unknown,
			outErr: unknown,
		) => number,
		args: { stream: bigint; maxTextBytes?: number; maxTokens?: number },
	): { partial: string; tokens?: number[] } {
		const err = makeOutErr();
		const textCap = args.maxTextBytes ?? 4096;
		const outText = new Uint8Array(textCap);
		const wantTokens = (args.maxTokens ?? 0) > 0;
		const tokenCap = wantTokens ? (args.maxTokens as number) : 0;
		const outTokens = wantTokens ? new Int32Array(tokenCap) : null;
		const ioNTokens = wantTokens
			? new BigUint64Array([BigInt(tokenCap)])
			: null;
		const rc = fn(
			args.stream,
			ffi.ptr(outText),
			BigInt(textCap),
			outTokens ? ffi.ptr(outTokens) : null,
			ioNTokens ? ffi.ptr(ioNTokens) : null,
			err.ptr,
		);
		if (rc < 0) {
			const message =
				takeError(err.buf) ??
				`[ffi-bindings] eliza_inference_asr_stream_${label} rc=${rc}`;
			throw new VoiceLifecycleError(failureCode(rc), message);
		}
		const nul = outText.indexOf(0, 0);
		const len = nul >= 0 ? nul : rc;
		const partial = Buffer.from(
			outText.buffer,
			outText.byteOffset,
			len,
		).toString("utf8");
		if (wantTokens && outTokens && ioNTokens) {
			const n = Number(ioNTokens[0] ?? 0n);
			const tokens = Array.from(outTokens.subarray(0, Math.min(n, tokenCap)));
			return { partial, tokens };
		}
		return { partial };
	}
}

function formatFfiError(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}

/**
 * Read an `EliVerifierEvent` (see `ffi.h`) from a C struct pointer.
 * Layout on 64-bit (8-byte aligned, default packing):
 *   off 0  : const int* accepted_token_ids   (8)
 *   off 8  : size_t      n_accepted           (8)
 *   off 16 : int         rejected_from        (4)
 *   off 20 : int         rejected_to          (4)
 *   off 24 : const int*  corrected_token_ids  (8)
 *   off 32 : size_t      n_corrected          (8)
 */
function readVerifierEvent(
	evPtr: bigint,
	ffi: BunFfiModule,
): NativeVerifierEvent {
	const acceptedPtr = ffi.read.ptr(evPtr, 0);
	const nAccepted = Number(ffi.read.u64(evPtr, 8));
	const rejectedFrom = ffi.read.i32(evPtr, 16);
	const rejectedTo = ffi.read.i32(evPtr, 20);
	const correctedPtr = ffi.read.ptr(evPtr, 24);
	const nCorrected = Number(ffi.read.u64(evPtr, 32));
	return {
		acceptedTokenIds: readInt32Array(acceptedPtr, nAccepted, ffi),
		rejectedFrom,
		rejectedTo,
		correctedTokenIds: readInt32Array(correctedPtr, nCorrected, ffi),
	};
}

function readInt32Array(
	ptr: bigint,
	count: number,
	ffi: BunFfiModule,
): number[] {
	if (ptr === 0n || count <= 0) return [];
	// Copy out — the array is the library's, valid only for the callback.
	const view = new Int32Array(ffi.toArrayBuffer(ptr, 0, count * 4).slice(0));
	return Array.from(view);
}

/**
 * Decode a `T.cstring` return value (Bun returns these as either a
 * lazy string-like object with `toString()` or a JS string depending
 * on version). Wrap so the caller never has to branch.
 */
function readCString(value: unknown, ffi: BunFfiModule): string {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	if (typeof value === "object" && value !== null && "toString" in value) {
		return (value as { toString(): string }).toString();
	}
	if (typeof value === "number" || typeof value === "bigint") {
		return new ffi.CString(value).toString();
	}
	return String(value);
}
