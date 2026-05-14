/**
 * Local image-generation (diffusion) types — WS3 deliverable.
 *
 * Two layers live here, mirroring the WS2 vision-describe split:
 *
 *   1. The **request/result** contract every WS3 backend implements
 *      (`ImageGenRequest`, `ImageGenResult`). Callers pass a text prompt
 *      and optional knobs; backends return PNG (or JPEG) bytes + metadata.
 *
 *   2. The **backend** interface (`ImageGenBackend`) that the
 *      `MemoryArbiter` (WS1) registers as a capability handler. One
 *      backend per per-platform diffusion runtime:
 *
 *        - `sd-cpp` — stable-diffusion.cpp child-process binary
 *          (Linux + Windows + Android JNI).
 *        - `mflux`  — MLX `mflux` Python venv (macOS Apple Silicon).
 *        - `coreml` — Capacitor bridge to Swift `apple/ml-stable-diffusion`
 *          (iOS only).
 *        - `tensorrt` — packaged `imagegen.exe` / `trtexec` wrapper
 *          (Windows NVIDIA).
 *        - `aosp`   — bun:ffi to `eliza_llama_imagegen_*` symbols in
 *          libeliza-llama-shim (Android JNI; stub here until shim
 *          ships).
 *        - `fake`   — deterministic in-process stub used by tests.
 *
 * All backends implement the same `load → generate → dispose` shape so the
 * arbiter can swap between them without caring how the diffusion runtime
 * is wired.
 *
 * Cache contract:
 *
 *   Image-gen requests do NOT go through `hashVisionInput` (that's the
 *   WS2 projector-token cache, which lives on image *inputs*). The
 *   request-side keying space is prompt + seed + steps + scheduler + …;
 *   if a cache lands here later it gets its own namespace (`hashImageGenRequest`)
 *   to avoid collisions with the WS2 vision-embedding cache. For now the
 *   capability has no result cache — diffusion is intrinsically expensive
 *   and most callers want a fresh sample, not a cached one.
 */

/** Output container the backend writes. PNG is default; JPEG is opt-in. */
export type ImageGenMimeType = "image/png" | "image/jpeg";

/**
 * Caller request to `generate`. All fields except `prompt` are optional —
 * backends apply per-runtime defaults for missing knobs.
 *
 * Knob semantics (consistent across backends):
 *
 *   - `width` / `height`: pixel resolution. Default 512×512 (SD 1.5 family) /
 *     1024×1024 (SDXL / FLUX / Z-Image). Backends round to the nearest
 *     multiple of 8 (SD) or 16 (SDXL) when needed.
 *   - `steps`: denoising step count. 4 for FLUX schnell / Z-Image-Turbo
 *     (single-pass Turbo schedulers); 20 for SD 1.5 Euler-A; 25 for SDXL.
 *   - `guidanceScale`: classifier-free guidance. Ignored by FLUX schnell
 *     (CFG-free). 7.5 default for SD 1.5; 4.0 default for SDXL.
 *   - `seed`: PRNG seed. -1 / omitted → random; the backend returns the
 *     actual seed used in `ImageGenResult.seed` so the caller can replay.
 *   - `scheduler`: sampler name (`"euler-a"`, `"dpm++-2m"`, `"ddim"`,
 *     `"euler"`). Backends accept the strings their underlying runtime
 *     supports; unknown values raise `ImageGenBackendUnavailableError`.
 */
export interface ImageGenRequest {
	prompt: string;
	negativePrompt?: string;
	width?: number;
	height?: number;
	steps?: number;
	guidanceScale?: number;
	seed?: number;
	scheduler?: string;
	signal?: AbortSignal;
	/**
	 * Optional per-step progress callback. Called once per denoising step
	 * with `{ step, total }`. Backends that can't surface step-level
	 * progress (Core ML batch fused path, TensorRT static engine) MAY
	 * call this once with `step === total` at completion instead of
	 * per-step. Never required.
	 */
	onProgressChunk?: (progress: { step: number; total: number }) => void;
}

/**
 * Backend response. `image` is the raw bytes (PNG by default); `mime`
 * identifies the container. The metadata block carries enough state for
 * the caller to attach to a chat turn, log to trajectories, or feed the
 * result back into a vision-describe for the same agent.
 */
export interface ImageGenResult {
	image: Uint8Array;
	mime: ImageGenMimeType;
	/**
	 * The actual seed the diffusion run used. Always populated — the
	 * backend MUST resolve a random seed before sampling and report it
	 * here. This is what makes a generation reproducible.
	 */
	seed: number;
	metadata: {
		/** The model id (catalog key) the run used (`"imagegen-sd-1_5-q5_0"`, etc.). */
		model: string;
		/** Echo of the prompt that was sampled. */
		prompt: string;
		/** Echo of the step count actually used (post-default-resolve). */
		steps: number;
		/** Echo of CFG actually applied. 0 for CFG-free models (FLUX schnell). */
		guidanceScale: number;
		/** End-to-end wall-clock time inside the backend. */
		inferenceTimeMs: number;
	};
}

/**
 * Per-load arguments for an image-gen backend. The arbiter's
 * `load(modelKey)` only carries an opaque key; the binding resolves that
 * key to real model+vae+clip+t5 paths through this struct, which
 * `createImageGenCapabilityRegistration` populates from the catalog +
 * `ELIZA_1_BUNDLE_EXTRAS.json`.
 *
 * Most diffusion families are single-file GGUFs once quantized — SD 1.5
 * Q5_0, Z-Image-Turbo Q4_K_M, FLUX.1 schnell Q4_K_M all bundle the
 * UNet/DiT + VAE + text encoders into one file. The optional `vae` /
 * `clip` / `t5` paths exist for runtimes that prefer split assets
 * (mlx-mflux ships split FLUX components; Core ML uses split `.mlpackage`
 * directories).
 */
export interface ImageGenLoadArgs {
	/** Absolute path to the primary diffusion weights (GGUF / mlpackage / engine). */
	modelPath: string;
	/** Optional split VAE path. */
	vae?: string;
	/** Optional split CLIP-L / CLIP-G path. */
	clip?: string;
	/** Optional split T5 / Gemma text encoder path. */
	t5?: string;
	/**
	 * Backend-specific acceleration hint. Accepts:
	 *   - `"auto"` (default) — let the binding decide.
	 *   - `"cpu"` — force CPU.
	 *   - `"cuda"` / `"vulkan"` / `"metal"` / `"coreml"` / `"qnn"` /
	 *     `"tensorrt"` — request a specific accelerator. Unsupported
	 *     requests fall back to `auto`.
	 */
	accelerator?:
		| "auto"
		| "cpu"
		| "cuda"
		| "vulkan"
		| "metal"
		| "coreml"
		| "qnn"
		| "tensorrt";
	/** Cancel a slow load (model file read + weight upload). */
	signal?: AbortSignal;
}

/**
 * The contract every WS3 backend implements. The shape is intentionally
 * narrow: the arbiter only ever calls `generate`. `dispose` is wrapped
 * by the arbiter's `unload` so the backend can free GPU/VRAM and drop
 * file descriptors / kill subprocesses on eviction.
 */
export interface ImageGenBackend {
	/** Stable identifier — matches the backend module name. */
	readonly id: "sd-cpp" | "mflux" | "coreml" | "tensorrt" | "aosp" | "fake";
	/**
	 * Best-effort capability check. Implementations return `false` for
	 * requests whose `width`/`height`/`scheduler` aren't supported by
	 * the loaded weights, so the arbiter can fall through to the next
	 * registered backend (selector order). Default backends accept
	 * anything reasonable; `supports` mostly matters for `coreml`
	 * (fixed resolution per `.mlpackage`) and `tensorrt` (fixed engine
	 * shape).
	 */
	supports(request: ImageGenRequest): boolean;
	generate(request: ImageGenRequest): Promise<ImageGenResult>;
	/** Release the loaded weights / subprocess. Idempotent. */
	dispose(): Promise<void>;
}

/**
 * Capability handler loader. The arbiter calls it with a model key
 * (e.g. `"imagegen-sd-1_5-q5_0"`); the implementation resolves to a
 * real `ImageGenLoadArgs` from `ELIZA_1_BUNDLE_EXTRAS.json` + the
 * installed bundle and returns a live backend.
 */
export type ImageGenBackendLoader = (
	modelKey: string,
) => Promise<ImageGenBackend>;
