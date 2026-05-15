/**
 * Local text-to-speech capability — public type surface.
 *
 * Mirrors the layout of `services/imagegen/types.ts` and `services/vision/types.ts`:
 *
 *   - The **request/result** contract every TTS backend implements
 *     (`TtsRequest`, `TtsResult`). The synth target is bytes (PCM/WAV/MP3).
 *
 *   - The **backend** interface (`TtsBackend`) that the WS1 `MemoryArbiter`
 *     registers as the `"speak"` capability handler. One backend per
 *     per-platform TTS runtime:
 *
 *       - `omnivoice` — fused omnivoice.cpp llama-server (desktop + AOSP)
 *         and the FFI streaming path (mobile). Default for tiers 9b / 27b
 *         / 27b-256k and a co-default for 9b.
 *       - `kokoro`    — Kokoro-82M ONNX/GGUF. Default for tiers 0_8b / 2b
 *         / 4b (the low-memory mobile floor). Co-default for 9b.
 *       - `edge-tts`  — Microsoft Edge cloud TTS, wired by
 *         `@elizaos/plugin-edge-tts`. Fallback when both local backends
 *         are unavailable (no GPU, missing weights). Routed via priority
 *         order in the runtime model registry, NOT as a sub-backend of
 *         this capability — Edge TTS is a different `provider` from the
 *         runtime's perspective.
 *       - `fake`      — deterministic in-process stub used by tests.
 *
 * Audio format contract:
 *   The arbiter's `speak` request returns Uint8Array. The bytes carry the
 *   audio container declared in `TtsResult.mime`:
 *     - `audio/wav`       — PCM in a RIFF/WAVE container (OmniVoice path
 *                            produces 24 kHz mono int16 by default).
 *     - `audio/mpeg`      — MP3 (Edge TTS default).
 *     - `audio/pcm-f32`   — bare 32-bit float PCM. Used internally between
 *                            Kokoro's runtime and the streaming sink; the
 *                            capability layer wraps it as WAV before
 *                            returning to TEXT_TO_SPEECH callers.
 *
 * Cache namespace:
 *   `tts-audio`. Keyed on `sha256(provider || model || voice || text)`.
 *   The first-line cache (`services/voice/wrap-with-first-line-cache.ts`)
 *   uses its own keying space and lives at a different layer; the
 *   capability-level cache (when wired) sits between the arbiter and the
 *   backend so it works for both local backends without each having to
 *   re-implement it.
 */

/** Audio container the backend returns. */
export type TtsMimeType =
	| "audio/wav"
	| "audio/mpeg"
	| "audio/pcm-f32"
	| "audio/opus";

/**
 * Caller request to `synthesize`. `text` is mandatory; everything else is
 * optional with backend-specific defaults.
 *
 * Knob semantics (consistent across backends):
 *   - `voice`: voice id. Kokoro uses ids like `"af_bella"`; OmniVoice uses
 *     a preset path / preset id from the speaker-preset store. Edge TTS
 *     uses Microsoft voice names (`"en-US-JennyNeural"`).
 *   - `speed`: speech rate. `1.0` is normal; `0.5` half; `2.0` double. The
 *     concrete backend maps this to its native knob (Edge TTS percentage
 *     string; Kokoro phoneme stretch; OmniVoice maskgit-step pacing).
 *   - `sampleRate`: target output sample rate when the container supports
 *     it. Backends MAY downsample / upsample to match; omitted = backend
 *     native (24 kHz for Kokoro and Edge TTS; 22.05 kHz for OmniVoice).
 *   - `signal`: abort hook. Backends honor this at chunk boundaries.
 */
export interface TtsRequest {
	text: string;
	voice?: string;
	speed?: number;
	sampleRate?: number;
	/** Hint to the backend that the caller wants streaming chunks. */
	streaming?: boolean;
	signal?: AbortSignal;
}

/**
 * Backend response. `audio` is the raw bytes in the container declared by
 * `mime`. `sampleRate` reports the *actual* sample rate the bytes carry
 * (which may differ from the requested `sampleRate` if the backend chose
 * its native rate).
 */
export interface TtsResult {
	audio: Uint8Array;
	mime: TtsMimeType;
	sampleRate: number;
	metadata: {
		/** The model id (catalog key) the run used (`"tts-omnivoice-base-Q8_0"`, `"tts-kokoro"`, etc.). */
		model: string;
		/** Resolved voice id (post-default-resolve). */
		voice: string;
		/** Echo of the text that was synthesized. */
		text: string;
		/** End-to-end wall-clock time inside the backend. */
		inferenceTimeMs: number;
		/** Whether the result came from the capability-level cache. */
		cacheHit?: boolean;
	};
}

/**
 * Per-load arguments for a TTS backend. The arbiter's `load(modelKey)`
 * only carries an opaque key; the binding resolves it to real
 * model+tokenizer+voice-preset paths through this struct, which
 * `createTtsCapabilityRegistration` populates from the catalog +
 * `ELIZA_1_GGUF_PLATFORM_PLAN.json`.
 *
 * The optional `voicePresetPath` exists because the runtime's default
 * voice ships as a precomputed `cache/voice-preset-default.bin` (ELZ2
 * v2). Backends that can use a frozen preset short-circuit the encoder
 * pass; backends that can't ignore the hint.
 */
export interface TtsLoadArgs {
	/** Absolute path to the primary TTS weights (GGUF for OmniVoice, ONNX for Kokoro). */
	modelPath: string;
	/** Optional tokenizer path (OmniVoice ships a separate `omnivoice-tokenizer-*.gguf`). */
	tokenizerPath?: string;
	/** Optional voice-preset cache path (`cache/voice-preset-default.bin`). */
	voicePresetPath?: string;
	/** Optional voice pack directory (Kokoro `voices/af_bella.bin`, etc.). */
	voicePackDir?: string;
	/** Cancel a slow load (model file read + weight upload). */
	signal?: AbortSignal;
}

/**
 * The contract every TTS backend implements. The shape is intentionally
 * narrow: the arbiter only ever calls `synthesize`. `dispose` is wrapped
 * by the arbiter's `unload` so the backend can free GPU/VRAM and drop
 * file descriptors / kill subprocesses on eviction.
 */
export interface TtsBackend {
	/** Stable identifier — matches the backend module name. */
	readonly id: "omnivoice" | "kokoro" | "edge-tts" | "fake";
	/**
	 * Best-effort capability check. Backends return `false` for requests
	 * whose `voice` / `sampleRate` aren't supported, so the arbiter can
	 * surface a clear error rather than synthesizing garbage. Default
	 * implementations accept anything reasonable; the gate matters for
	 * Kokoro (fixed voice pack list) and OmniVoice (cloned-voice presets
	 * tied to a specific bundle).
	 */
	supports(request: TtsRequest): boolean;
	synthesize(request: TtsRequest): Promise<TtsResult>;
	/** Release the loaded weights / subprocess. Idempotent. */
	dispose(): Promise<void>;
}

/**
 * Capability handler loader. The arbiter calls it with a model key (e.g.
 * `"tts-omnivoice-base-Q8_0"`); the implementation resolves to a real
 * `TtsLoadArgs` from `ELIZA_1_GGUF_PLATFORM_PLAN.json` + the installed
 * bundle and returns a live backend.
 */
export type TtsBackendLoader = (modelKey: string) => Promise<TtsBackend>;
