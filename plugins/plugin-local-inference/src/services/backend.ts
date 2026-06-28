/**
 * Local-inference backend interface and dispatcher.
 *
 * Both shipping backends are served by the SAME in-process FFI
 * `libelizainference` library behind the SAME streaming symbols — the
 * difference is which in-process runtime the FFI's `llm_backend_select` drives:
 *
 *   - `llama-cpp`  → the optimized in-process FFI llama.cpp path (the default).
 *     MTP, n-gram drafter, lookahead, `-ot` MoE offload, TurboQuant KV
 *     cache, mlock/no-mmap/mmproj, etc. all live here. Serves the `.gguf`.
 *   - `litert-lm`  → the in-process LiteRT-LM backend (Android NPU / GPU
 *     delegate, gated `-DELIZA_ENABLE_LITERT`). Serves a `.litertlm` text
 *     artifact staged under `<bundleRoot>/text/`. The dispatcher passes
 *     `ELIZA_LLM_BACKEND=litert-lm` through the load; the C-side
 *     `llm_backend_select` reads it (and probes `text/*.litertlm`) and routes
 *     to the LiteRT factory. See `tools/omnivoice/src/llm-backend.h`.
 *
 * The dispatcher decides which one to use per-load based on:
 *
 *   1. `ELIZA_INFERENCE_BACKEND` env override — `llama-cpp` / `litert-lm` /
 *      `auto`. A `litert-lm` force is honoured only when the build/platform
 *      supports LiteRT and the bundle ships a `.litertlm` (else hard error).
 *   2. A `.litertlm` text artifact in the bundle AND LiteRT support on this
 *      build/platform → `litert-lm`. GGUF stays the default whenever the
 *      LiteRT artifact or the build support is absent.
 *   3. Catalog `runtime.optimizations.requiresKernel` — if any specialised
 *      llama.cpp kernel is required (e.g. `turbo3`), the
 *      dispatcher picks `llama-cpp`. Legacy bindings cannot
 *      provide these kernels at all.
 *   4. Default: optimized llama.cpp FFI.
 *
 * The dispatcher does NOT own backend internals. It owns selection only,
 * plus a small load-state
 * cache so callers can swap models without touching either backend
 * directly.
 */

import { findCatalogModel } from "./catalog";
import type { StructuredGenerateParams } from "./structured-output";
import type { CatalogModel, LocalRuntimeKernel } from "./types";
import type { VerifierStreamEvent } from "./voice/types";

/**
 * Per-load runtime overrides forwarded by the dispatcher to whichever
 * backend handles the load. Mirror of the relevant fields on
 * `LocalInferenceLoadArgs` from `active-model.ts` — kept inline here so
 * `backend.ts` stays free of cross-file circular imports (active-model
 * imports engine, engine imports backend).
 */
export interface BackendLoadOverrides {
	contextSize?: number;
	cacheTypeK?: string;
	cacheTypeV?: string;
	gpuLayers?: number | "auto" | "max";
	kvOffload?: "cpu" | "gpu" | "split" | { gpuLayers: number };
	flashAttention?: boolean;
	mmap?: boolean;
	mlock?: boolean;
	useGpu?: boolean;
	/** Absolute path to a multimodal projector GGUF passed to the FFI runtime. */
	mmprojPath?: string;
	/** Absolute path to the MTP drafter GGUF passed to the FFI runtime. */
	draftModelPath?: string;
	/** Eliza-1 bundle root for direct bundle loads not present in the registry. */
	bundleRoot?: string;
	/** Manifest path for direct bundle loads not present in the registry. */
	manifestPath?: string;
	/**
	 * Absolute path to a `.litertlm` LiteRT-LM text artifact staged under
	 * `<bundleRoot>/text/`, when the bundle ships one. Presence (plus LiteRT
	 * build/platform support) routes the load to the `litert-lm` backend; the
	 * `.gguf` `modelPath` stays the GGUF default otherwise.
	 */
	litertModelPath?: string;
}

export interface BackendPlan {
	/** Absolute path to the GGUF on disk. */
	modelPath: string;
	/**
	 * Catalog model id, when known. The dispatcher uses this to pull
	 * `runtime.optimizations` and `runtime.mtp` — without it, we can
	 * only honour the env override and fall back to `capacitor-llama`.
	 */
	modelId?: string;
	/** Catalog entry, when the caller already resolved it. */
	catalog?: CatalogModel;
	/**
	 * Per-load runtime overrides resolved by the active-model coordinator.
	 * The dispatcher passes these through verbatim to the chosen backend
	 * so the in-process binding can honour cache-type and contextSize
	 * requests instead of silently dropping them.
	 */
	overrides?: BackendLoadOverrides;
}

export interface GenerateArgs extends StructuredGenerateParams {
	prompt: string;
	stopSequences?: string[];
	/** Upper bound on output tokens; defaults to 2048. */
	maxTokens?: number;
	/** 0..1; 0.7 default. */
	temperature?: number;
	/** Nucleus sampling; defaults to 0.9. */
	topP?: number;
	/**
	 * Optional cache key from the runtime's `ProviderCachePlan`. Identical
	 * keys reuse the same KV cache prefix: the `llama-cpp` FFI backend derives
	 * a deterministic slot so requests with the same key land on the same
	 * persisted KV state. Empty / absent keys fall through to the historical
	 * stateless path.
	 */
	cacheKey?: string;
	/**
	 * Per-request abort signal. The `llama-cpp` FFI backend honours it
	 * cooperatively by cancelling the active FFI stream. Callers that want
	 * hard cancel for things like app pause / kill-switch pass the same signal
	 * here that they pass into `runtime.useModel`.
	 */
	signal?: AbortSignal;
	/**
	 * Optional per-request backend transport budget. This should be at least as
	 * long as the caller's user-visible generation timeout; shorter inner
	 * timeouts abort long local-prefill turns before the chat route can make the
	 * user-facing decision.
	 */
	requestTimeoutMs?: number;
	/**
	 * Incremental accepted text from the backend. The `llama-cpp` FFI backend
	 * calls this as accepted chunks arrive, per `llmStreamNext` step (it
	 * streams even when a `grammar` is set).
	 */
	onTextChunk?: (chunk: string) => void | Promise<void>;
	/**
	 * Max tokens the FFI backend decodes per `llmStreamNext` step — i.e. the
	 * granularity of `onTextChunk` emission. Smaller ⇒ smoother token-by-token
	 * streaming to the UI at the cost of more FFI round-trips per response.
	 * Unset ⇒ the backend default (coarse, throughput-tuned). The text/chat
	 * handler sets a small value for smooth streaming; voice leaves it unset.
	 */
	maxTokensPerStep?: number;
	/**
	 * Whether this generation is user-visible text and therefore eligible for
	 * voice-mode TTS. Internal JSON / planner calls must not be spoken.
	 */
	voiceOutput?: "user-visible" | "internal";
	/**
	 * Native verifier stream from speculative MTP. Exact accept/reject token
	 * ranges let voice TTS rollback avoid inferring state from text chunks.
	 */
	onVerifierEvent?: (event: VerifierStreamEvent) => void | Promise<void>;
}

export type GenerateResult = string;

export interface LocalGenerateWithUsageResult {
	text: string;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		[key: string]: unknown;
	};
	slotId?: number;
	firstTokenMs?: number | null;
	mtpStats?: {
		drafted: number;
		accepted: number;
		acceptanceRate: number | null;
	};
}

/**
 * The in-process runtime the FFI streaming pipe drives for a given load.
 * `llama-cpp` is the default GGUF path; `litert-lm` is the LiteRT-LM
 * `.litertlm` path (same FFI symbols, selected via `ELIZA_LLM_BACKEND` +
 * the C-side `llm_backend_select`). This is the dispatcher's *selection*,
 * distinct from `LocalInferenceBackend.id` (the implementation surface, which
 * stays the single fused FFI backend regardless of the runtime it drives).
 */
export type BackendId = "llama-cpp" | "litert-lm";

export interface LocalRuntimeLoadConfig {
	modelId: string | null;
	modelPath: string | null;
	contextSize: number | null;
	cacheTypeK: string | null;
	cacheTypeV: string | null;
	gpuLayers: number | null;
	parallel: number;
	binaryPath: string | null;
	backend: BackendId | null;
	mtp: {
		specType: "draft-mtp";
		draftMin: number;
		draftMax: number;
	} | null;
}

/**
 * The backend contract every local-inference implementation satisfies.
 *
 * `available()` is a soft probe — it should NOT spawn anything; it just
 * reports whether the backend can be used at all (e.g. is the binding
 * loadable, is the binary on disk). Loading a specific model is `load()`.
 */
export interface LocalInferenceBackend {
	/** Identifier for the concrete backend implementation. */
	readonly id: "llama-cpp";
	available(): Promise<boolean>;
	load(plan: BackendPlan): Promise<void>;
	unload(): Promise<void>;
	generate(args: GenerateArgs): Promise<GenerateResult>;
	hasLoadedModel(): boolean;
	currentModelPath(): string | null;

	// === Optional methods — backends that don't implement them are surfaced
	// === via `dispatcher.X?.()` calls in `engine.ts`, with safe fallback
	// === values for query methods and actionable throws for required ops.
	// ===
	// === These exist so engine.ts can drive every optimized llama.cpp-specific
	// === feature through the dispatcher and keep FFI as the single runtime
	// === implementation surface.

	/**
	 * Usage-instrumented variant of `generate`. Returns Anthropic-shape
	 * usage block plus per-turn MTP stats when available.
	 */
	generateWithUsage?(
		args: GenerateArgs & { slotId?: number },
	): Promise<LocalGenerateWithUsageResult>;

	/** Vision describe via mmproj. Requires an mmproj-loaded backend. */
	describeImage?(args: {
		bytes: Uint8Array;
		mimeType?: string;
		prompt?: string;
		maxTokens?: number;
		temperature?: number;
		signal?: AbortSignal;
		/** Per-token callback for streaming vision describe (ABI v13). When set and
		 * the backend supports streaming, the description is decoded token-by-token
		 * through the same pipe as chat text; otherwise the backend returns the
		 * full description and ignores it. */
		onTextChunk?: (chunk: string) => void | Promise<void>;
		maxTokensPerStep?: number;
	}): Promise<{
		text: string;
		projectorMs?: number;
		decodeMs?: number;
	}>;

	/** Persist a slot's KV cache to disk under the conversation directory. */
	persistConversationKv?(conversationId: string, slotId: number): Promise<void>;

	/** Restore a slot's KV cache from disk into the running backend. */
	restoreConversationKv?(
		conversationId: string,
		slotId: number,
	): Promise<boolean>;

	/**
	 * Pre-decode `promptPrefix` into the named slot/cache key so the next
	 * `generate` against the same key skips re-prefill. Returns false when
	 * no warmup happened (already cached, no model loaded, etc).
	 */
	prewarmConversation?(
		promptPrefix: string,
		opts: { slotId: number; cacheKey: string },
	): Promise<boolean>;

	/**
	 * Resize the backend's parallel slot pool. Returns true on a real
	 * restart/resize, false when no resize was needed (target ≤ current, etc).
	 */
	resizeParallel?(target: number): Promise<boolean>;

	/** Active parallel slot count. Default `1` on backends without pooling. */
	parallelSlots?(): number;

	/** True when native MTP speculative decoding is enabled. */
	mtpEnabled?(): boolean;

	/** Absolute path to the loaded mmproj (vision) GGUF, or null. */
	currentMmprojPath?(): string | null;

	/**
	 * Snapshot of the backend's current load configuration (ctx, cache
	 * types, parallel, binary path). Used by engine introspection +
	 * /api/local-inference/active.
	 */
	currentRuntimeLoadConfig?(): LocalRuntimeLoadConfig | null;
}

export type BackendOverride = "auto" | "llama-cpp" | "litert-lm";

/**
 * The env name the C-side `llm_backend_select` reads to HARD-select an
 * in-process runtime. The dispatcher sets it to `litert-lm` for a LiteRT load
 * and clears it for a llama.cpp load so a prior LiteRT select never leaks into
 * the next GGUF load. Mirrors `tools/omnivoice/src/llm-backend.h`.
 */
export const ELIZA_LLM_BACKEND_ENV = "ELIZA_LLM_BACKEND" as const;

export function readBackendOverride(): BackendOverride {
	const raw = process.env.ELIZA_INFERENCE_BACKEND?.trim().toLowerCase();
	if (raw === "auto") return "auto";
	if (raw === "llama-cpp") {
		return "llama-cpp";
	}
	if (raw === "litert-lm" || raw === "litert" || raw === "litert_lm") {
		return "litert-lm";
	}
	return "auto";
}

/**
 * Whether the LiteRT-LM in-process backend is usable on THIS build/platform.
 * The C-side `LlmBackendFactory::available()` is the runtime authority (it is
 * compiled in only under `-DELIZA_ENABLE_LITERT` and reports false when the
 * NPU/GPU delegate is absent), but the TS dispatcher must decide *before* the
 * FFI load whether to route there at all, so we gate on the same signals the
 * build/launcher exports:
 *
 *   - `ELIZA_ENABLE_LITERT=1` — the explicit opt-in the LiteRT-enabled build
 *     sets (matches the `-DELIZA_ENABLE_LITERT` CMake gate).
 *   - `ELIZA_PLATFORM=android` — the NPU/GPU-delegate target where a LiteRT
 *     `.litertlm` bundle is the on-device path.
 *
 * A bundle that ships a `.litertlm` but runs on a build without LiteRT support
 * loads the GGUF (`llama-cpp`) instead — the artifact is additive, never a
 * requirement. Returns false unless one of the signals is present, so GGUF
 * stays the default everywhere LiteRT is not wired.
 */
export function litertBackendSupported(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (envFlagIn(env, "ELIZA_ENABLE_LITERT")) return true;
	return env.ELIZA_PLATFORM?.trim().toLowerCase() === "android";
}

function envFlagIn(env: NodeJS.ProcessEnv, name: string): boolean {
	const v = env[name]?.trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}

function envFlag(name: string): boolean {
	const v = process.env[name]?.trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Opt-in "reduced-optimization local mode" (the cross-platform escape hatch
 * documented in `docs/voice-interactive.md` and `packages/inference/AGENTS.md`
 * §4): when the installed llama.cpp runtime does not advertise the
 * custom Eliza-1 KV kernels (`turbo3`/`qjl_full`/`polarquant`/…) — i.e. the
 * fork hasn't been built with those kernels dispatched on this backend yet —
 * setting `ELIZA_LOCAL_ALLOW_STOCK_KV=1` lets the model load anyway with
 * stock `f16` KV cache instead of hard-refusing. The voice pipeline runs;
 * it just runs without the KV-compression speedups on that backend. A loud
 * one-time warning is emitted (see `warnReducedOptimizationLocalMode`).
 *
 * §3-vs-"works everywhere" reconciliation: AGENTS.md §3 says these kernels
 * are *mandatory* and there is *no* "fallback to unoptimized" path. The
 * user's directive for SA-1 is "works everywhere regardless of GPU". The
 * reconciliation: the kernels DO build on every backend where they can be
 * dispatched (Metal, CUDA, Vulkan-source-patched, CPU SIMD TUs), and this
 * fallback is the *opt-in*, *loudly-warned*, *non-publishable* mode for the
 * backends where dispatch isn't wired yet — it is not a silent downgrade,
 * and `defaultEligible` bundles still require the verified kernels.
 */
export function localAllowStockKv(): boolean {
	return envFlag("ELIZA_LOCAL_ALLOW_STOCK_KV");
}

let reducedModeWarned = false;
export function warnReducedOptimizationLocalMode(detail: string): void {
	if (reducedModeWarned) return;
	reducedModeWarned = true;
	console.warn(
		`\n[local-inference] ⚠️  REDUCED-OPTIMIZATION LOCAL MODE — ${detail}\n` +
			`  ELIZA_LOCAL_ALLOW_STOCK_KV=1 is set, so the model is loading with stock\n` +
			`  f16 KV cache instead of the Eliza-1 TurboQuant/QJL/PolarQuant KV kernels.\n` +
			`  The voice pipeline will run, but slower and using more memory than a build\n` +
			`  with the kernels dispatched (Metal: all 5; CUDA: ships them; Vulkan: source-\n` +
			`  patched; CPU: SIMD TUs). Rebuild the bundled llama.cpp FFI runtime\n` +
			`  to get the optimized path. This mode is NOT publishable and NOT a default.\n`,
	);
}

/** Reset the one-time warning latch (tests only). */
export function __resetReducedModeWarnedForTests(): void {
	reducedModeWarned = false;
}

export interface BackendDecision {
	/**
	 * In-process runtime the dispatcher routes this load to. `llama-cpp` (the
	 * GGUF path) is the default; `litert-lm` is selected only when the bundle
	 * ships a `.litertlm` AND the build/platform supports LiteRT (or it was
	 * forced via `ELIZA_INFERENCE_BACKEND=litert-lm`). Both run through the same
	 * fused `libelizainference` FFI — the selection only changes the env the
	 * C-side `llm_backend_select` reads.
	 */
	backend: BackendId;
	/** Why this backend was chosen — for diagnostics and warnings. */
	reason:
		| "env-override"
		| "kernel-required"
		| "preferred-backend"
		| "litert-artifact"
		| "default";
	/**
	 * Absolute path to the selected `.litertlm` artifact when `backend ===
	 * "litert-lm"`, else undefined. The dispatcher exports
	 * `ELIZA_LLM_BACKEND=litert-lm` for this load so the FFI picks the LiteRT
	 * factory; the path is surfaced for diagnostics.
	 */
	litertModelPath?: string;
	/** Required kernels declared by the catalog, when any. */
	kernels: LocalRuntimeKernel[];
	/**
	 * Set when the dispatcher detected a kernel mismatch — the catalog model
	 * declares `requiresKernel: [...]` but CAPABILITIES.json next to the
	 * installed binary reports those kernels as unavailable. The dispatcher
	 * still routes to optimized llama.cpp (the only backend that could satisfy
	 * those kernels), but the load is expected to fail; the caller should
	 * surface this to the operator with a clear "rebuild your binary"
	 * message instead of letting the model silently misbehave.
	 */
	unsatisfiedKernels?: LocalRuntimeKernel[];
}

/**
 * Pure decision function. Easy to unit-test without spawning anything.
 *
 * Inputs are deliberately explicit — the caller resolves the catalog entry,
 * the binary availability, the env override, and (for LiteRT) the staged
 * `.litertlm` path + the build/platform support flag before calling us.
 *
 * `binaryKernels`, when present, is the parsed CAPABILITIES.json kernels
 * map from the installed llama.cpp FFI runtime. The dispatcher uses it to
 * compute `unsatisfiedKernels`; null means the binary is older / has no
 * capabilities probe, in which case we trust the model's declaration and
 * let the load attempt clarify.
 *
 * `litertModelPath` is the absolute path to a `.litertlm` text artifact when
 * the bundle ships one (else undefined); `litertSupported` is whether this
 * build/platform can run LiteRT ({@link litertBackendSupported}). LiteRT is
 * selected only when BOTH hold, or when forced via
 * `ELIZA_INFERENCE_BACKEND=litert-lm` (a forced LiteRT select with no
 * `.litertlm` or no support throws — no silent downgrade to GGUF). GGUF stays
 * the default in every other case.
 */
export function decideBackend(input: {
	override: BackendOverride;
	catalog: CatalogModel | undefined;
	llamaCppAvailable: boolean;
	binaryKernels?: Partial<Record<LocalRuntimeKernel | string, boolean>> | null;
	litertModelPath?: string | null;
	litertSupported?: boolean;
}): BackendDecision {
	const { override, catalog } = input;
	const optimizations = catalog?.runtime?.optimizations;
	const kernels = optimizations?.requiresKernel ?? [];
	const unsatisfiedKernels = computeUnsatisfiedKernels(
		kernels,
		input.binaryKernels ?? null,
	);
	const litertModelPath = input.litertModelPath ?? undefined;
	const litertSupported = input.litertSupported ?? false;

	// `ELIZA_INFERENCE_BACKEND=litert-lm` HARD-forces the LiteRT runtime. It is a
	// real select, not a hint: a forced LiteRT load with no staged `.litertlm`
	// or on a build without LiteRT support is an error, never a silent fall back
	// to GGUF (Commandment 8 — don't paper over a broken pipeline).
	if (override === "litert-lm") {
		if (!litertSupported) {
			throw new Error(
				"[local-inference] ELIZA_INFERENCE_BACKEND=litert-lm forces the LiteRT-LM " +
					"backend, but this build/platform does not support it (set ELIZA_ENABLE_LITERT=1 " +
					"on a LiteRT-enabled build, or run on android). Use llama-cpp, or unset the override.",
			);
		}
		if (!litertModelPath) {
			throw new Error(
				"[local-inference] ELIZA_INFERENCE_BACKEND=litert-lm forces the LiteRT-LM " +
					"backend, but the bundle ships no .litertlm text artifact under text/. " +
					"Stage a .litertlm into the bundle, or use llama-cpp.",
			);
		}
		return {
			backend: "litert-lm",
			reason: "env-override",
			litertModelPath,
			kernels,
			unsatisfiedKernels,
		};
	}

	// `ELIZA_INFERENCE_BACKEND=llama-cpp` forces the fused GGUF path explicitly.
	if (override === "llama-cpp") {
		return {
			backend: "llama-cpp",
			reason: "env-override",
			kernels,
			unsatisfiedKernels,
		};
	}

	// Auto: when the bundle ships a `.litertlm` AND this build/platform supports
	// LiteRT, route there (it is the on-device NPU/GPU-delegate path). GGUF stays
	// the default whenever the artifact or the support is absent.
	if (litertSupported && litertModelPath) {
		return {
			backend: "litert-lm",
			reason: "litert-artifact",
			litertModelPath,
			kernels,
			unsatisfiedKernels,
		};
	}

	if (kernels.length > 0) {
		return {
			backend: "llama-cpp",
			reason: "kernel-required",
			kernels,
			unsatisfiedKernels,
		};
	}
	return {
		backend: "llama-cpp",
		reason: "default",
		kernels,
		unsatisfiedKernels,
	};
}

/**
 * Returns the subset of `required` kernels that aren't reported as `true`
 * in the binary's CAPABILITIES.json. Returns undefined when no probe is
 * available; an empty array means "all required kernels are satisfied".
 */
function computeUnsatisfiedKernels(
	required: LocalRuntimeKernel[],
	binaryKernels: Partial<Record<LocalRuntimeKernel | string, boolean>> | null,
): LocalRuntimeKernel[] | undefined {
	if (required.length === 0) return undefined;
	if (!binaryKernels) return undefined;
	return required.filter((k) => binaryKernels[k] !== true);
}

/**
 * Resolve the catalog entry for a `BackendPlan`. Plans may carry the entry
 * already (when the caller has it on hand), reference it by id, or carry
 * neither — in which case the dispatcher falls back to the default backend.
 */
export function resolveCatalogForPlan(
	plan: BackendPlan,
): CatalogModel | undefined {
	if (plan.catalog) return plan.catalog;
	if (plan.modelId) return findCatalogModel(plan.modelId);
	return undefined;
}

/**
 * Dispatcher that fronts the in-process FFI llama.cpp backend behind the
 * `LocalInferenceBackend` contract. Holds at most one active backend at a
 * time — load() unloads the previous backend before loading the new one if
 * they differ.
 */
export class BackendDispatcher implements LocalInferenceBackend {
	readonly id = "llama-cpp" as const;
	// The dispatcher's `id` is informational; the active backend's id is what
	// matters for diagnostics. We expose `activeBackendId()` for that.

	private active: LocalInferenceBackend | null = null;

	constructor(
		private readonly ffiStreaming: LocalInferenceBackend,
		private readonly probeFfiAvailable: () => boolean,
		/**
		 * Optional capabilities probe that returns the kernels map from the
		 * installed llama.cpp FFI runtime, or null when no probe is available.
		 * Used to flag `unsatisfiedKernels`
		 * in the BackendDecision before load() so callers can give a clean
		 * "rebuild your fork binary" error instead of a kernel SIGSEGV at
		 * generation time.
		 */
		private readonly probeBinaryKernels?: () => Partial<
			Record<string, boolean>
		> | null,
	) {}

	async available(): Promise<boolean> {
		return this.ffiStreaming.available();
	}

	activeBackendId(): "llama-cpp" | null {
		return this.active ? this.active.id : null;
	}

	hasLoadedModel(): boolean {
		return this.active?.hasLoadedModel() ?? false;
	}

	currentModelPath(): string | null {
		return this.active?.currentModelPath() ?? null;
	}

	decide(plan: BackendPlan): BackendDecision {
		const catalog = resolveCatalogForPlan(plan);
		return decideBackend({
			override: readBackendOverride(),
			catalog,
			llamaCppAvailable: this.probeFfiAvailable(),
			binaryKernels: this.probeBinaryKernels?.() ?? null,
			litertModelPath: plan.overrides?.litertModelPath ?? null,
			litertSupported: litertBackendSupported(),
		});
	}

	async load(plan: BackendPlan): Promise<void> {
		const decision = this.decide(plan);

		// Tell the C-side `llm_backend_select` which in-process runtime to drive.
		// `litert-lm` sets the HARD select; the GGUF path clears it so a prior
		// LiteRT select never leaks into the next llama.cpp load. The FFI library
		// is the same singleton either way (`this.ffiStreaming`); only the env
		// (read at `_open`) changes which factory it picks.
		if (decision.backend === "litert-lm") {
			process.env[ELIZA_LLM_BACKEND_ENV] = "litert-lm";
		} else {
			delete process.env[ELIZA_LLM_BACKEND_ENV];
		}

		let effectivePlan = plan;
		// Kernel-mismatch enforcement is a llama.cpp-only contract — the LiteRT
		// `.litertlm` path uses none of the fork's KV kernels, so skip it there.
		if (
			decision.backend === "llama-cpp" &&
			decision.unsatisfiedKernels &&
			decision.unsatisfiedKernels.length > 0
		) {
			const missing = decision.unsatisfiedKernels.join(", ");
			if (localAllowStockKv()) {
				// Reduced-optimization local mode: the build hasn't dispatched these
				// kernels on this backend yet, but the user opted into running with
				// stock f16 KV instead of hard-refusing. Strip any custom cache-type
				// override from the plan so the FFI runtime uses f16, and warn
				// loudly exactly once.
				warnReducedOptimizationLocalMode(
					`catalog model requires kernel(s) {${missing}}, not advertised by the installed llama.cpp FFI runtime`,
				);
				if (
					plan.overrides &&
					(plan.overrides.cacheTypeK !== undefined ||
						plan.overrides.cacheTypeV !== undefined)
				) {
					const { cacheTypeK: _k, cacheTypeV: _v, ...rest } = plan.overrides;
					effectivePlan = { ...plan, overrides: { ...rest } };
				}
			} else {
				throw new Error(
					`[local-inference] Catalog model requires kernel(s) {${missing}}, but the installed llama.cpp FFI runtime does not advertise them. Rebuild the bundled runtime for this target, pick a different model, or set ELIZA_LOCAL_ALLOW_STOCK_KV=1 to load with stock f16 KV (reduced-optimization local mode — loud warning, not publishable).`,
				);
			}
		}
		if (!this.probeFfiAvailable()) {
			throw new Error(
				"[local-inference] Optimized llama.cpp requires the in-process FFI backend. " +
					"Install/rebuild libelizainference with streaming-LLM + MTP support; " +
					"server backends are not supported.",
			);
		}
		const target = this.ffiStreaming;
		if (this.active && this.active !== target) {
			await this.active.unload();
		}
		this.active = target;
		await target.load(effectivePlan);
	}

	async unload(): Promise<void> {
		const active = this.active;
		this.active = null;
		if (active) await active.unload();
	}

	async generate(args: GenerateArgs): Promise<GenerateResult> {
		if (!this.active) {
			throw new Error(
				"[local-inference] No backend loaded. Call load() before generate().",
			);
		}
		return this.active.generate(args);
	}

	// === Forwarders for the optional methods on LocalInferenceBackend.
	// === Required ops (generate / describe / persist / restore / prewarm /
	// === resize / restart) throw an actionable error when the active
	// === backend doesn't implement them, pointing at the FFI parity gap.
	// === Query getters return safe defaults that match the engine's
	// === existing guard expectations.

	async generateWithUsage(
		args: GenerateArgs & { slotId?: number },
	): Promise<LocalGenerateWithUsageResult> {
		this.ensureLoaded();
		if (!this.active?.generateWithUsage) {
			throw this.notSupported("generateWithUsage");
		}
		return this.active?.generateWithUsage(args);
	}

	async describeImage(
		args: Parameters<NonNullable<LocalInferenceBackend["describeImage"]>>[0],
	): ReturnType<NonNullable<LocalInferenceBackend["describeImage"]>> {
		this.ensureLoaded();
		if (!this.active?.describeImage) {
			throw this.notSupported(
				"describeImage",
				"vision describe requires an mmproj-loaded llama.cpp FFI runtime. Load an Eliza-1 bundle with its vision projector.",
			);
		}
		return this.active?.describeImage(args);
	}

	async persistConversationKv(
		conversationId: string,
		slotId: number,
	): Promise<void> {
		this.ensureLoaded();
		if (!this.active?.persistConversationKv) return;
		await this.active?.persistConversationKv(conversationId, slotId);
	}

	async restoreConversationKv(
		conversationId: string,
		slotId: number,
	): Promise<boolean> {
		this.ensureLoaded();
		if (!this.active?.restoreConversationKv) return false;
		return this.active?.restoreConversationKv(conversationId, slotId);
	}

	async prewarmConversation(
		promptPrefix: string,
		opts: { slotId: number; cacheKey: string },
	): Promise<boolean> {
		this.ensureLoaded();
		if (!this.active?.prewarmConversation) return false;
		return this.active?.prewarmConversation(promptPrefix, opts);
	}

	async resizeParallel(target: number): Promise<boolean> {
		this.ensureLoaded();
		if (!this.active?.resizeParallel) return false;
		return this.active?.resizeParallel(target);
	}

	parallelSlots(): number {
		return this.active?.parallelSlots?.() ?? 1;
	}

	mtpEnabled(): boolean {
		return this.active?.mtpEnabled?.() ?? false;
	}

	currentMmprojPath(): string | null {
		return this.active?.currentMmprojPath?.() ?? null;
	}

	currentRuntimeLoadConfig(): LocalRuntimeLoadConfig | null {
		return this.active?.currentRuntimeLoadConfig?.() ?? null;
	}

	private ensureLoaded(): void {
		if (!this.active) {
			throw new Error(
				"[local-inference] No backend loaded. Call load() first.",
			);
		}
	}

	private notSupported(method: string, detail?: string): Error {
		const base = `[local-inference] Active backend (${this.active?.id ?? "<none>"}) does not implement ${method}.`;
		return new Error(detail ? `${base} ${detail}` : base);
	}
}
