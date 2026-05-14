/**
 * Vision-language describe-image types (WS2).
 *
 * Two layers live here:
 *
 *   1. The **request/result** contract every WS2 backend implements
 *      (`VisionDescribeRequest`, `VisionDescribeResult`). Callers pass
 *      raw image bytes + a prompt; backends return a title+description.
 *
 *   2. The **backend** interface (`VisionDescribeBackend`) that the
 *      `MemoryArbiter` registers as a capability handler. One backend
 *      per binding family (node-llama-cpp / llama-server / AOSP libllama
 *      shim). All three implement the same `load → describe → unload`
 *      shape so the arbiter can swap between them without caring how
 *      the projector is wired underneath.
 *
 * Why a separate file: the arbiter's `CapabilityRegistration<TBackend,
 * TRequest, TResult>` is generic; pinning concrete shapes here keeps
 * the registration sites short and removes a dozen casts at the
 * call-site.
 */

/**
 * Channel order for the raw pixel buffer. Most platforms hand us RGBA
 * (HTMLCanvasElement, Capacitor `Camera`, the desktop `puppeteer-core`
 * screenshot pipeline). The encoder normalizes internally; this enum
 * stays so the hash step can pick a stable byte layout that doesn't
 * depend on the platform-provided buffer order.
 */
export type VisionImageChannelOrder = "rgba" | "rgb" | "bgra" | "bgr";

/**
 * The raw image data the backend will encode. The arbiter does not see
 * this — it gets handed straight to the backend's `run()`. The reason
 * we accept multiple wrappers (URL / base64 / bytes) is that the three
 * upstream entry points (HTTP route, agent runtime model handler,
 * computer-use frame loop) each prefer a different shape. The backend
 * resolves to bytes once.
 */
export type VisionImageInput =
	| { kind: "bytes"; bytes: Uint8Array; mimeType?: string }
	| { kind: "base64"; base64: string; mimeType?: string }
	| { kind: "dataUrl"; dataUrl: string }
	| { kind: "url"; url: string; mimeType?: string };

/**
 * Caller request to `describeImage`. The `modelFamily` distinguishes
 * projected-token cache entries from different VL families that share
 * the same hash space — Qwen3-VL tokens are not interchangeable with
 * Florence-2 tokens. Default is `qwen3-vl` (the WS2 deliverable);
 * future families register under their own identifier.
 */
export interface VisionDescribeRequest {
	image: VisionImageInput;
	prompt?: string;
	/**
	 * The model family identifier. Used to namespace the projector cache
	 * so swapping the backend's model family invalidates cached tokens.
	 * Defaults to `"qwen3-vl"` when omitted.
	 */
	modelFamily?: string;
	/** Max output tokens; defaults to 256 (description-length budget). */
	maxTokens?: number;
	/** 0..1, default 0.2 (descriptions should be deterministic-ish). */
	temperature?: number;
	signal?: AbortSignal;
}

/** Backend response — same shape that ImageDescriptionResult expects. */
export interface VisionDescribeResult {
	title: string;
	description: string;
	/** Best-effort: ms spent in the projector (for arbiter telemetry). */
	projectorMs?: number;
	/** Best-effort: ms spent in the decoder. */
	decodeMs?: number;
	/** Whether the projected tokens came from the WS1 vision cache. */
	cacheHit?: boolean;
}

/**
 * Per-load arguments for a vision-describe backend. The arbiter's
 * `load(modelKey)` only carries an opaque key; the binding resolves
 * that key to real model+mmproj paths through this struct, which
 * `createVisionCapabilityRegistration` populates from the catalog.
 */
export interface VisionDescribeLoadArgs {
	/** Absolute path to the text decoder GGUF (the "main" model). */
	modelPath: string;
	/** Absolute path to the matching mmproj projector GGUF. */
	mmprojPath: string;
	/**
	 * GPU offload preference. The backend translates this to its native
	 * knob: node-llama-cpp `gpuLayers`, llama-server `--n-gpu-layers`,
	 * AOSP libllama shim `eliza_llama_model_params_set_n_gpu_layers`.
	 * `"auto"` lets the binding decide; numeric is honoured verbatim.
	 */
	gpuLayers?: number | "auto" | "max";
	/** Max sampled context window in tokens. Defaults to 4096. */
	contextSize?: number;
}

/**
 * The contract every WS2 backend implements. The shape is intentionally
 * narrow: the arbiter only ever calls `describe`. `dispose` is wrapped
 * by the arbiter's `unload` so the backend can free GPU/VRAM and drop
 * file descriptors on eviction.
 */
export interface VisionDescribeBackend {
	/** Stable identifier — `"node-llama-cpp"`, `"llama-server"`, `"aosp"`, or `"fake"` (tests). */
	readonly id:
		| "node-llama-cpp"
		| "llama-server"
		| "aosp"
		| "fake";
	/**
	 * Run a describe pass. Backends MAY consult an injected projector cache
	 * via `args.projectedTokens` (when the caller's hash already produced
	 * a cache hit) instead of running the projector again; backends that
	 * don't implement projector-token reuse ignore the field.
	 */
	describe(
		request: VisionDescribeRequest,
		args?: VisionDescribeBackendOptions,
	): Promise<VisionDescribeResult>;
	/** Release the loaded weights. Idempotent. */
	dispose(): Promise<void>;
}

/**
 * Per-call options the arbiter wrapper passes into the backend. Lives
 * here (rather than on `VisionDescribeRequest`) so the caller-facing
 * request type stays free of arbiter implementation details.
 */
export interface VisionDescribeBackendOptions {
	/**
	 * Pre-computed projected tokens from the WS1 vision-embedding cache.
	 * When present the backend SHOULD skip its own projector step and
	 * decode against these tokens directly. Backends that can't do this
	 * still produce a correct result by ignoring the field; the arbiter's
	 * wrapper will measure `cacheHit: false` in that case.
	 */
	projectedTokens?: {
		tokens: Float32Array;
		tokenCount: number;
		hiddenSize: number;
	};
}

/**
 * Capability handler load function. The arbiter calls it with a model
 * key (e.g. `"qwen3-vl-2b"`); the implementation resolves to a real
 * `(modelPath, mmprojPath)` pair from the catalog + installed registry
 * and returns a live backend.
 */
export type VisionDescribeBackendLoader = (
	modelKey: string,
) => Promise<VisionDescribeBackend>;
