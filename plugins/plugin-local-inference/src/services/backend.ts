/**
 * Local-inference backend interface and dispatcher.
 *
 * Two real implementations live behind this interface:
 *
 *   - `capacitor-llama`  → in-process via the capacitor-llama binding. Stock
 *     GGUFs, no drafter, no MoE expert offload, no `--lookahead`. Fastest
 *     to start, lowest IPC overhead, narrowest feature surface.
 *   - `llama-server`    → out-of-process llama-server (the buun-llama-cpp
 *     fork). Full optimization surface — DFlash, n-gram drafter, lookahead,
 *     `-ot` MoE offload, TurboQuant KV cache, mlock/no-mmap/mmproj, etc.
 *
 * The dispatcher decides which one to use per-load based on:
 *
 *   1. `ELIZA_LOCAL_BACKEND=node-llama-cpp|llama-server|auto` — operator
 *      override. `auto` (the default) hands the decision to the catalog.
 *   2. Catalog `runtime.optimizations.requiresKernel` — if any specialised
 *      llama-server kernel is required (e.g. `dflash`, `turbo3`), the
 *      dispatcher MUST pick `llama-server`. The in-process binding cannot
 *      provide these kernels at all.
 *   3. Catalog `runtime.preferredBackend` — soft preference. We pick
 *      `llama-server` when this is set AND the binary is available;
 *      otherwise we fall back to `capacitor-llama` unless DFlash is
 *      explicitly required (`ELIZA_DFLASH_REQUIRED=1`).
 *   4. Default: custom `llama-server` when the managed binary is available;
 *      `capacitor-llama` is only a last-resort compatibility path for hosts
 *      without the custom llama.cpp runtime.
 *
 * The dispatcher does NOT own the spawn body — `llama-server` and the
 * node binding own that. It owns selection only, plus a small load-state
 * cache so callers can swap models without touching either backend
 * directly.
 */

import { findCatalogModel } from "./catalog";
// NOTE: `import type` is erased at runtime — backend.ts and dflash-server.ts
// can reference each other's *types* without creating a runtime circular.
// dflash-server.ts already imports types from here (`LocalInferenceBackend`,
// `BackendPlan`, etc); this is the symmetric type-only edge.
import type {
	DflashGenerateResult,
	DflashRuntimeLoadConfig,
} from "./dflash-server";
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
	/** Absolute path to a multimodal projector GGUF passed to llama-server as --mmproj. */
	mmprojPath?: string;
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
	 * `runtime.optimizations` and `runtime.dflash` — without it, we can
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
	 *   - `llama-server`   → derives a deterministic `slot_id` so requests
	 *     with the same key land on the same persisted slot.
	 * Empty / absent keys fall through to the historical stateless path.
	 */
	cacheKey?: string;
	/**
	 * Per-request abort signal. Backends honour it cooperatively:
	 *   - `capacitor-llama` passes it to `LlamaChatSession.prompt()` as
	 *     `stopOnAbortSignal`, so the binding bails out of the generation
	 *     loop on the next sampler tick.
	 *   - `llama-server`   wires it into the HTTP request so the outgoing
	 *     fetch is cancelled and the server-side slot releases the KV.
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
	 * Incremental accepted text from the backend. llama-server calls this for
	 * streamed OpenAI-compatible deltas; node-llama-cpp calls it once with the
	 * completed text until the binding path exposes token callbacks here.
	 */
	onTextChunk?: (chunk: string) => void | Promise<void>;
	/**
	 * Whether this generation is user-visible text and therefore eligible for
	 * voice-mode TTS. Internal JSON / planner calls must not be spoken.
	 */
	voiceOutput?: "user-visible" | "internal";
	/**
	 * Native verifier stream from speculative backends. Current llama-server
	 * builds synthesize accept events from streamed text deltas; future DFlash
	 * builds should emit exact accept/reject token ranges here so voice TTS
	 * rollback does not need to infer them from text chunks.
	 */
	onVerifierEvent?: (event: VerifierStreamEvent) => void | Promise<void>;
}

export type GenerateResult = string;

export interface EmbedArgs {
	input: string;
}

export interface EmbedResult {
	embedding: number[];
	tokens: number;
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
	readonly id: "capacitor-llama" | "node-llama-cpp" | "llama-server";
	available(): Promise<boolean>;
	load(plan: BackendPlan): Promise<void>;
	unload(): Promise<void>;
	generate(args: GenerateArgs): Promise<GenerateResult>;
	embed?(args: EmbedArgs): Promise<EmbedResult>;
	hasLoadedModel(): boolean;
	currentModelPath(): string | null;

	// === Optional methods — backends that don't implement them are surfaced
	// === via `dispatcher.X?.()` calls in `engine.ts`, with safe fallback
	// === values for query methods and actionable throws for required ops.
	// ===
	// === These exist so engine.ts can drive every llama-server-specific
	// === feature through the dispatcher instead of importing the
	// === `dflashLlamaServer` singleton directly. Eventual deletion of
	// === `dflash-server.ts` (the file) requires (a) every engine call site
	// === to use these dispatcher methods and (b) a replacement
	// === implementation of each method on the FFI backend. See
	// === `plugins/plugin-local-inference/FFI_BACKEND_WIREUP_PLAN.md`.

	/**
	 * Usage-instrumented variant of `generate`. Returns Anthropic-shape
	 * usage block + per-turn DFlash speculative stats. Required on the
	 * llama-server backend; FFI backends will need parity before any
	 * caller switches to FFI for slot-aware generation.
	 */
	generateWithUsage?(
		args: GenerateArgs & { slotId?: number },
	): Promise<DflashGenerateResult>;

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
	 * Resize the backend's parallel slot pool. llama-server-specific —
	 * the FFI runner has a single-slot lifecycle today. Returns true on
	 * a real restart, false on no-op (target ≤ current, etc).
	 */
	resizeParallel?(target: number): Promise<boolean>;

	/**
	 * Eviction-style restart that drops the DFlash drafter (`-md`) and
	 * frees its memory. Returns true when a restart happened.
	 */
	restartWithoutDrafter?(): Promise<boolean>;

	/** Active parallel slot count. Default `1` on backends without pooling. */
	parallelSlots?(): number;

	/** True when speculative decoding is wired against a loaded drafter. */
	drafterEnabled?(): boolean;

	/** Absolute path to the loaded drafter GGUF, or null. */
	loadedDrafterModelPath?(): string | null;

	/** Absolute path to the loaded mmproj (vision) GGUF, or null. */
	currentMmprojPath?(): string | null;

	/**
	 * Snapshot of the backend's current load configuration (ctx, cache
	 * types, parallel, binary path). Used by engine introspection +
	 * /api/local-inference/active.
	 */
	currentRuntimeLoadConfig?(): DflashRuntimeLoadConfig | null;
}

export type BackendOverride = "auto" | "capacitor-llama" | "llama-server";

export function readBackendOverride(): BackendOverride {
	const raw = process.env.ELIZA_LOCAL_BACKEND?.trim().toLowerCase();
	if (raw === "capacitor-llama" || raw === "llama-server" || raw === "auto") {
		return raw;
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
 * §4): when the installed `llama-server` binary does not advertise the
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
			`  patched; CPU: SIMD TUs). Rebuild the fork with the matching backend\n` +
			`  (node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target <triple>)\n` +
			`  to get the optimized path. This mode is NOT publishable and NOT a default.\n`,
	);
}

/** Reset the one-time warning latch (tests only). */
export function __resetReducedModeWarnedForTests(): void {
	reducedModeWarned = false;
}

export interface BackendDecision {
	backend: "capacitor-llama" | "llama-server";
	/** Why this backend was chosen — for diagnostics and warnings. */
	reason:
		| "env-override"
		| "kernel-required"
		| "dflash-required"
		| "preferred-backend"
		| "default";
	/** Required kernels declared by the catalog, when any. */
	kernels: LocalRuntimeKernel[];
	/**
	 * Set when the dispatcher detected a kernel mismatch — the catalog model
	 * declares `requiresKernel: [...]` but CAPABILITIES.json next to the
	 * installed binary reports those kernels as unavailable. The dispatcher
	 * still routes to llama-server (the only backend that could ever satisfy
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
 * map from the installed llama-server build. The dispatcher uses it to
 * compute `unsatisfiedKernels`; null means the binary is older / has no
 * capabilities probe, in which case we trust the model's declaration and
 * let the load attempt clarify.
 */
export function decideBackend(input: {
	override: BackendOverride;
	catalog: CatalogModel | undefined;
	llamaServerAvailable: boolean;
	dflashRequired: boolean;
	binaryKernels?: Partial<Record<LocalRuntimeKernel | string, boolean>> | null;
}): BackendDecision {
	const { override, catalog, llamaServerAvailable, dflashRequired } = input;
	const optimizations = catalog?.runtime?.optimizations;
	const kernels = optimizations?.requiresKernel ?? [];
	const dflashConfigured = catalog?.runtime?.dflash;
	const preferredBackend = catalog?.runtime?.preferredBackend;
	const unsatisfiedKernels = computeUnsatisfiedKernels(
		kernels,
		input.binaryKernels ?? null,
	);

	if (override === "capacitor-llama") {
		if (kernels.length > 0 || dflashRequired) {
			// The override conflicts with a hard requirement. Prefer the kernel
			// requirement — silently honoring the override would silently break
			// the model. Surface as a llama-server pick; the load itself will
			// fail clearly if the binary really is missing.
			return {
				backend: "llama-server",
				reason: "kernel-required",
				kernels,
				unsatisfiedKernels,
			};
		}
		return {
			backend: "capacitor-llama",
			reason: "env-override",
			kernels,
			unsatisfiedKernels,
		};
	}
	if (override === "llama-server") {
		return {
			backend: "llama-server",
			reason: "env-override",
			kernels,
			unsatisfiedKernels,
		};
	}

	if (kernels.length > 0) {
		return {
			backend: "llama-server",
			reason: "kernel-required",
			kernels,
			unsatisfiedKernels,
		};
	}
	if (dflashConfigured && dflashRequired) {
		return {
			backend: "llama-server",
			reason: "dflash-required",
			kernels,
			unsatisfiedKernels,
		};
	}
	if (preferredBackend === "llama-server" && llamaServerAvailable) {
		return {
			backend: "llama-server",
			reason: "preferred-backend",
			kernels,
			unsatisfiedKernels,
		};
	}
	if (preferredBackend === "capacitor-llama") {
		return {
			backend: "capacitor-llama",
			reason: "preferred-backend",
			kernels,
			unsatisfiedKernels,
		};
	}
	if (llamaServerAvailable) {
		return {
			backend: "llama-server",
			reason: "default",
			kernels,
			unsatisfiedKernels,
		};
	}
	return {
		backend: "capacitor-llama",
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
		private readonly llamaServer: LocalInferenceBackend,
		private readonly probeLlamaServerAvailable: () => boolean,
		private readonly probeDflashRequired: () => boolean,
		/**
		 * Optional capabilities probe that returns the kernels map from
		 * CAPABILITIES.json next to the installed llama-server binary, or
		 * null when the file is absent. Used to flag `unsatisfiedKernels`
		 * in the BackendDecision before load() so callers can give a clean
		 * "rebuild your fork binary" error instead of a kernel SIGSEGV at
		 * generation time.
		 */
		private readonly probeBinaryKernels?: () => Partial<
			Record<string, boolean>
		> | null,
		/**
		 * In-process FFI streaming backend (production: the desktop
		 * libllama+shim adapter via bun:ffi — see
		 * `services/desktop-ffi-backend-runtime.ts`). Replaces the
		 * subprocess `llamaServer` whenever `probeFfiActive()` returns
		 * `true`. Both must be supplied; when either is omitted the
		 * dispatcher routes every `decideBackend() === "llama-server"`
		 * load through the subprocess fallback unchanged.
		 */
		private readonly ffiStreaming?: LocalInferenceBackend,
		/**
		 * Companion probe to `ffiStreaming`. Called inside `load()` when
		 * `decideBackend()` returns `"llama-server"` — `true` routes the
		 * load through the FFI backend, `false` keeps the subprocess path.
		 * The engine's probe checks dylib disk presence and honors
		 * `ELIZA_INFERENCE_BACKEND=http` as the explicit opt-out.
		 */
		private readonly probeFfiActive?: () => boolean,
	) {}

	async available(): Promise<boolean> {
		const a = await this.nodeLlamaCpp.available();
		if (a) return true;
		return this.llamaServer.available();
	}

	activeBackendId():
		| "capacitor-llama"
		| "node-llama-cpp"
		| "llama-server"
		| null {
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
			llamaServerAvailable: this.probeLlamaServerAvailable(),
			dflashRequired: this.probeDflashRequired(),
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
				// override from the plan so the llama-server spawn uses f16, and warn
				// loudly exactly once.
				warnReducedOptimizationLocalMode(
					`catalog model requires kernel(s) {${missing}}, not advertised by the installed llama-server binary`,
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
					`[local-inference] Catalog model requires kernel(s) {${missing}}, but the installed llama-server binary does not advertise them in CAPABILITIES.json. Rebuild the fork with the matching backend (e.g. node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target <triple>), pick a different model, or set ELIZA_LOCAL_ALLOW_STOCK_KV=1 to load with stock f16 KV (reduced-optimization local mode — loud warning, not publishable).`,
				);
			}
		}
		const ffiStreaming = this.ffiStreaming;

		// FFI is the default desktop path. When the dispatcher routes to
		// `llama-server` AND a wired FFI backend's probe says go, we
		// route through it; otherwise the subprocess fallback runs.
		// `ELIZA_INFERENCE_BACKEND=http` is the explicit opt-out (probe
		// returns false). No "ffi" opt-in flag — it's the default.
		const wantsFfi =
			decision.backend === "llama-server" &&
			ffiStreaming !== undefined &&
			(this.probeFfiActive?.() ?? false);
		const target =
			decision.backend === "llama-server"
				? wantsFfi
					? ffiStreaming
					: this.llamaServer
				: this.nodeLlamaCpp;
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

	async embed(args: EmbedArgs): Promise<EmbedResult> {
		if (!this.active) {
			throw new Error(
				"[local-inference] No backend loaded. Call load() before embed().",
			);
		}
		if (!this.active.embed) {
			throw new Error(
				`[local-inference] Active backend (${this.active.id}) does not implement embed.`,
			);
		}
		return this.active.embed(args);
	}

	// === Forwarders for the optional methods on LocalInferenceBackend.
	// === Required ops (generate / describe / persist / restore / prewarm /
	// === resize / restart) throw an actionable error when the active
	// === backend doesn't implement them, pointing at the FFI parity gap.
	// === Query getters return safe defaults that match the engine's
	// === existing guard expectations.

	async generateWithUsage(
		args: GenerateArgs & { slotId?: number },
	): Promise<DflashGenerateResult> {
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
				"vision describe requires an mmproj-loaded llama-server. Load an Eliza-1 bundle, or wait for FFI mmproj parity.",
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

	async restartWithoutDrafter(): Promise<boolean> {
		this.ensureLoaded();
		if (!this.active?.restartWithoutDrafter) return false;
		return this.active?.restartWithoutDrafter();
	}

	parallelSlots(): number {
		return this.active?.parallelSlots?.() ?? 1;
	}

	drafterEnabled(): boolean {
		return this.active?.drafterEnabled?.() ?? false;
	}

	loadedDrafterModelPath(): string | null {
		return this.active?.loadedDrafterModelPath?.() ?? null;
	}

	currentMmprojPath(): string | null {
		return this.active?.currentMmprojPath?.() ?? null;
	}

	currentRuntimeLoadConfig(): DflashRuntimeLoadConfig | null {
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
