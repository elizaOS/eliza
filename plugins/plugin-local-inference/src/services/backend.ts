/**
 * Local-inference backend interface and dispatcher.
 *
 * One shipping implementation lives behind this interface:
 *
 *   - `llama-cpp`       → the optimized in-process FFI llama.cpp path.
 *     MTP, n-gram drafter, lookahead, `-ot` MoE offload, TurboQuant KV
 *     cache, mlock/no-mmap/mmproj, etc. all live here.
 *
 * The dispatcher decides which one to use per-load based on:
 *
 *   1. Catalog `runtime.optimizations.requiresKernel` — if any specialised
 *      llama.cpp kernel is required (e.g. `turbo3`), the
 *      dispatcher MUST pick `llama-cpp`. Legacy bindings cannot
 *      provide these kernels at all.
 *   2. Catalog `runtime.preferredBackend` — retained for metadata
 *      compatibility, but generation still routes through `llama-cpp`.
 *   3. Default: optimized llama.cpp FFI.
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
}

export function gpuLayersForKvOffload(
	mode: NonNullable<BackendLoadOverrides["kvOffload"]>,
): number | "auto" | "max" {
	if (mode === "cpu") return 0;
	if (mode === "gpu") return "max";
	if (mode === "split") return "auto";
	return mode.gpuLayers;
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
	 * keys reuse the same KV cache prefix in both backends:
	 *   - `capacitor-llama` → routes to a pooled `LlamaChatSession` that
	 *     retains chat history (and therefore the KV) across calls.
	 *   - `llama-cpp`      → derives a deterministic slot so requests
	 *     with the same key land on the same persisted KV state.
	 * Empty / absent keys fall through to the historical stateless path.
	 */
	cacheKey?: string;
	/**
	 * Per-request abort signal. Backends honour it cooperatively:
	 *   - `capacitor-llama` passes it to `LlamaChatSession.prompt()` as
	 *     `stopOnAbortSignal`, so the binding bails out of the generation
	 *     loop on the next sampler tick.
	 *   - `llama-cpp`      cancels the active FFI stream.
	 * Callers that want hard cancel for things like app pause / kill-switch
	 * pass the same signal here that they pass into `runtime.useModel`.
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
	 * Incremental accepted text from the backend. Both backends call this as
	 * accepted chunks arrive: the FFI path per `llmStreamNext` step, and
	 * node-llama-cpp per token via `session.prompt({ onTextChunk })` (which
	 * streams even when a `grammar` is set).
	 */
	onTextChunk?: (chunk: string) => void | Promise<void>;
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

export interface LocalRuntimeLoadConfig {
	modelId: string | null;
	modelPath: string | null;
	contextSize: number | null;
	cacheTypeK: string | null;
	cacheTypeV: string | null;
	gpuLayers: number | null;
	parallel: number;
	binaryPath: string | null;
	backend: "capacitor-llama" | "node-llama-cpp" | "llama-cpp" | null;
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
	readonly id: "capacitor-llama" | "node-llama-cpp" | "llama-cpp";
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

export type BackendOverride = "auto" | "llama-cpp";

export function readBackendOverride(): BackendOverride {
	const raw = process.env.ELIZA_INFERENCE_BACKEND?.trim().toLowerCase();
	if (raw === "auto") return "auto";
	if (raw === "llama-cpp") {
		return "llama-cpp";
	}
	return "auto";
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
	backend: "llama-cpp";
	/** Why this backend was chosen — for diagnostics and warnings. */
	reason: "env-override" | "kernel-required" | "preferred-backend" | "default";
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
 * the binary availability, and the env override before calling us.
 *
 * `binaryKernels`, when present, is the parsed CAPABILITIES.json kernels
 * map from the installed llama.cpp FFI runtime. The dispatcher uses it to
 * compute `unsatisfiedKernels`; null means the binary is older / has no
 * capabilities probe, in which case we trust the model's declaration and
 * let the load attempt clarify.
 */
export function decideBackend(input: {
	override: BackendOverride;
	catalog: CatalogModel | undefined;
	llamaCppAvailable: boolean;
	binaryKernels?: Partial<Record<LocalRuntimeKernel | string, boolean>> | null;
}): BackendDecision {
	const { override, catalog } = input;
	const optimizations = catalog?.runtime?.optimizations;
	const kernels = optimizations?.requiresKernel ?? [];
	const unsatisfiedKernels = computeUnsatisfiedKernels(
		kernels,
		input.binaryKernels ?? null,
	);

	if (override === "llama-cpp") {
		return {
			backend: "llama-cpp",
			reason: "env-override",
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
 * Dispatcher that fronts both backends behind the `LocalInferenceBackend`
 * contract. Holds at most one active backend at a time — load() unloads
 * the previous backend before loading the new one if they differ.
 */
export class BackendDispatcher implements LocalInferenceBackend {
	readonly id = "capacitor-llama" as const;
	// The dispatcher's `id` is informational; the active backend's id is what
	// matters for diagnostics. We expose `activeBackendId()` for that.

	private active: LocalInferenceBackend | null = null;

	constructor(
		private readonly nodeLlamaCpp: LocalInferenceBackend,
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
		const a = await this.nodeLlamaCpp.available();
		if (a) return true;
		return this.ffiStreaming.available();
	}

	activeBackendId(): "capacitor-llama" | "node-llama-cpp" | "llama-cpp" | null {
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
		});
	}

	async load(plan: BackendPlan): Promise<void> {
		let effectivePlan = plan;
		const decision = this.decide(plan);
		if (decision.unsatisfiedKernels && decision.unsatisfiedKernels.length > 0) {
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
		if (decision.backend === "llama-cpp" && !this.probeFfiAvailable()) {
			throw new Error(
				"[local-inference] Optimized llama.cpp requires the in-process FFI backend. " +
					"Install/rebuild libelizainference with streaming-LLM + MTP support; " +
					"server backends are not supported.",
			);
		}
		const target =
			decision.backend === "llama-cpp" ? this.ffiStreaming : this.nodeLlamaCpp;
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
