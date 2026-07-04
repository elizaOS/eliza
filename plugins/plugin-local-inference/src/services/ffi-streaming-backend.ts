/**
 * In-process FFI streaming backend adapter.
 *
 * Implements `LocalInferenceBackend` as the optimized in-process
 * llama.cpp path used by Eliza-1 on desktop and mobile.
 *
 * What this class deliberately does NOT do:
 *   - Own the FFI context. The runtime provider passed to this class owns
 *     native load/unload and hands back the binding, context, and tokenizer.
 *   - Decode image bytes or call mtmd directly. Vision requests are validated
 *     here, then forwarded to runtimes that expose `describeImage`.
 */

import { statSync } from "node:fs";
import { logger } from "@elizaos/core";
import type {
	BackendPlan,
	GenerateArgs,
	GenerateResult,
	LocalGenerateWithUsageResult,
	LocalInferenceBackend,
} from "./backend";
import type { FfiStreamingRunner } from "./ffi-streaming-runner";
import type {
	LlmCtxHandle,
	LlmStreamingBinding,
} from "./llm-streaming-binding";
import { resolveGuidedDecodeForParams } from "./structured-output";
import {
	type BudgetReservation,
	ensureSharedVoiceBudget,
	type VoiceBudget,
} from "./voice/voice-budget";

/**
 * Constructor-injected adapter that resolves the FFI binding, context, and
 * tokenizer for a given load. Two responsibilities:
 *
 *   1. Decide whether the FFI path is viable on the current binding
 *      (`supported()`). Mirrors `LlmStreamingBinding.llmStreamSupported()`
 *      plus any higher-level constraints (e.g. dylib path exists, build
 *      target matches the bundle's required kernels).
 *   2. Lifecycle: `acquire(plan)` returns the FFI runner ready for
 *      `generate()` against the requested model, plus a tokenizer that
 *      matches that model's vocab. `release()` tears everything down.
 *
 * Production runtime implementation: the fused libelizainference path
 * (`desktop-fused-ffi-backend-runtime.ts`), which wraps `ElizaInferenceFfi`
 * via `wrapElizaInferenceFfi()` from `services/llm-streaming-binding.ts`.
 * libllama has been retired — there is no second runtime behind this slot.
 */
export interface FfiBackendRuntime {
	supported(): boolean;
	acquire(plan: BackendPlan): Promise<FfiBackendSession>;
	release(): Promise<void>;
	/**
	 * Optional parallel-slot pool surface. When the runtime exposes a
	 * ctx pool (the desktop libllama path does), `parallelSlots()`
	 * reports the live count and `resizeParallel(N)` grows/shrinks it.
	 * Runtimes without a pool report 1 and ignore resize requests.
	 */
	parallelSlots?(): number;
	resizeParallel?(target: number): Promise<boolean>;
}

/**
 * Result of `FfiBackendRuntime.acquire()` — a live FFI session bound to a
 * specific loaded model.
 */
export interface FfiBackendSession {
	readonly binding: LlmStreamingBinding;
	readonly ctx: LlmCtxHandle;
	readonly runner: FfiStreamingRunner;
	/**
	 * Tokenize a prompt string into model token ids using the loaded model's
	 * tokenizer. The vocab MUST match the GGUF — mismatches produce gibberish
	 * silently. The runtime is responsible for asserting this at acquire
	 * time.
	 */
	readonly tokenize: (prompt: string) => Int32Array;
	/**
	 * Native MTP speculative-decoding policy from the catalog. `null`
	 * disables speculative decoding for this session.
	 */
	readonly mtp: {
		specType: "draft-mtp";
		draftMin: number;
		draftMax: number;
		gpuLayers: number | "auto";
	} | null;
	/**
	 * Absolute path to a *separate* MTP drafter GGUF resolved during load.
	 * `null` means embedded-draft-head MTP: the draft head is embedded in
	 * the main text GGUF and the native runner activates `--spec-type
	 * draft-mtp` with no `-md`. Speculative decoding is governed by `mtp`,
	 * not by the presence of this path.
	 */
	readonly draftModelPath: string | null;
	/**
	 * Multimodal projector (mmproj) GGUF path for vision describe. Resolved
	 * from `plan.overrides.mmprojPath` at acquire time. `null` disables
	 * vision — `describeImage` then throws an actionable error.
	 */
	readonly mmprojPath: string | null;
	/**
	 * Per-load runtime config the fused libelizainference path applies at its
	 * first `llmStreamOpen` (context size, gpuLayers + KV-cache quant types). The desktop
	 * libllama runtime applies these at `loadModel()` instead and leaves this
	 * `null` — the backend forwards them into the runner's per-call config only
	 * when present, so the fused path mirrors the libllama load decision without
	 * the libllama path double-applying them.
	 */
	readonly loadConfig?: {
		contextSize?: number;
		gpuLayers?: number;
		cacheTypeK?: string | null;
		cacheTypeV?: string | null;
	} | null;
}

/**
 * Adapter that satisfies `LocalInferenceBackend` by delegating to
 * `FfiStreamingRunner`. The `id` is `"llama-cpp"` because this is the
 * in-process variant of the optimized llama.cpp path.
 */
export class FfiStreamingBackend implements LocalInferenceBackend {
	readonly id = "llama-cpp" as const;

	private session: FfiBackendSession | null = null;
	private loadedPath: string | null = null;
	/** Voice-budget reservations for the loaded weights (text target +
	 *  optional separate MTP drafter). Released on unload. */
	private budgetReservations: BudgetReservation[] = [];
	private readonly budgetOverride: VoiceBudget | null;

	constructor(
		private readonly runtime: FfiBackendRuntime,
		opts: { budget?: VoiceBudget } = {},
	) {
		this.budgetOverride = opts.budget ?? null;
	}

	async available(): Promise<boolean> {
		return this.runtime.supported();
	}

	hasLoadedModel(): boolean {
		return this.session !== null;
	}

	currentModelPath(): string | null {
		return this.loadedPath;
	}

	async load(plan: BackendPlan): Promise<void> {
		if (this.session) await this.unload();
		// Reserve the text-target weights against the cross-model voice budget
		// BEFORE loading (allocator contract, `voice-budget.ts`). Sized to the
		// GGUF on disk — the mmap resident ceiling. `BudgetExhaustedError` is a
		// hard load failure: the model genuinely does not fit this tier's
		// co-resident budget. A path with no stat-able file carries nothing to
		// account (the runtime's own acquire decides whether that is fatal).
		const textBytes = fileSizeOrNull(plan.modelPath);
		if (textBytes !== null) {
			const budget = this.budgetOverride ?? (await ensureSharedVoiceBudget());
			this.budgetReservations.push(
				await budget.reserve({
					modelId: plan.modelPath,
					role: "text-target",
					bytes: textBytes,
				}),
			);
		}
		try {
			this.session = await this.runtime.acquire(plan);
		} catch (err) {
			this.releaseBudgetReservations();
			throw err;
		}
		this.loadedPath = plan.modelPath;
		// A separate MTP drafter GGUF is only known post-acquire; reserve it
		// now. Embedded-draft-head MTP shares the text weights — no extra
		// reservation.
		const draftPath = this.session.draftModelPath;
		const draftBytes = draftPath ? fileSizeOrNull(draftPath) : null;
		if (draftPath && draftBytes !== null) {
			const budget = this.budgetOverride ?? (await ensureSharedVoiceBudget());
			try {
				this.budgetReservations.push(
					await budget.reserve({
						modelId: draftPath,
						role: "drafter",
						bytes: draftBytes,
					}),
				);
			} catch (err) {
				logger.error(
					{
						draftPath,
						error: err instanceof Error ? err.message : String(err),
					},
					"[FfiStreamingBackend] drafter weights exceed the voice budget — unloading",
				);
				await this.unload();
				throw err;
			}
		}
	}

	private releaseBudgetReservations(): void {
		for (const r of this.budgetReservations) r.release();
		this.budgetReservations = [];
	}

	async unload(): Promise<void> {
		// Await the native release BEFORE nulling our refs. If we null first and
		// release() throws (a raw bun:ffi free can reject), this.session would be
		// null while the runtime still holds a live session — the next load()
		// would skip unload() and call acquire(), which throws on its live-session
		// guard, wedging the backend until process restart. The finally guarantees
		// our refs are cleared regardless so a failed release can't leave a stale
		// "loaded" view either.
		try {
			await this.runtime.release();
		} finally {
			this.session = null;
			this.loadedPath = null;
			this.releaseBudgetReservations();
		}
	}

	async generate(args: GenerateArgs): Promise<GenerateResult> {
		const result = await this.generateWithUsage(args);
		return result.text;
	}

	async generateWithUsage(
		args: GenerateArgs & { slotId?: number },
	): Promise<LocalGenerateWithUsageResult> {
		if (!this.session) {
			throw new Error(
				"[ffi-streaming-backend] generate() called before load() — " +
					"the FFI session has not been acquired.",
			);
		}
		const { runner, tokenize, mtp, draftModelPath, loadConfig } = this.session;
		// Force the structured-reply envelope: compile the GBNF from the
		// caller's `responseSkeleton` / explicit `grammar` (precedence handled
		// by `resolveGuidedDecodeForParams`, mirroring `engine.ts`'s
		// `resolveBindingGrammarSource`). The native session installs it FIRST
		// in the sampler chain so every sampled token is grammar-constrained.
		const gbnfGrammar =
			resolveGuidedDecodeForParams(args).grammar?.source ?? null;
		const result = await runner.generateWithUsage({
			promptTokens: tokenize(args.prompt),
			slotId: args.slotId ?? -1,
			cacheKey: args.cacheKey,
			maxTokens: args.maxTokens ?? 2048,
			temperature: args.temperature ?? 0.7,
			topP: args.topP ?? 0.9,
			topK: 40,
			repeatPenalty: 1.1,
			draftMin: mtp?.draftMin ?? 0,
			draftMax: mtp?.draftMax ?? 0,
			draftModelPath,
			gbnfGrammar,
			gpuLayers: loadConfig?.gpuLayers,
			cacheTypeK: loadConfig?.cacheTypeK,
			cacheTypeV: loadConfig?.cacheTypeV,
			contextSize: loadConfig?.contextSize,
			signal: args.signal,
			maxTokensPerStep: args.maxTokensPerStep,
			onTextChunk: args.onTextChunk,
			onVerifierEvent: args.onVerifierEvent,
		});
		return {
			text: result.text,
			slotId: result.slotId,
			firstTokenMs: result.firstTokenMs,
			usage: {
				completion_tokens: result.accepted,
			},
			mtpStats: {
				drafted: result.drafted,
				accepted: result.accepted,
				acceptanceRate:
					result.drafted > 0 ? result.accepted / result.drafted : null,
			},
		};
	}

	// === Optional `LocalInferenceBackend` methods routed through the runner.

	/**
	 * Persist the active session's KV state to a per-conversation file.
	 * v1 uses `llama_state_seq_save_file` against seq_id=0. The on-disk file
	 * path mirrors `ffi-streaming-backend.ts`'s conversation-keyed slot layout
	 * (`<cacheDir>/<conversationId>/<slotId>.kv`) so a switch between
	 * FFI and subprocess can resume each other's slots — once both
	 * paths agree on the file format.
	 */
	async persistConversationKv(
		conversationId: string,
		slotId: number,
	): Promise<void> {
		if (!this.session) return; // no active session to persist
		const { binding } = this.session;
		if (!binding.llmStreamSaveSlot) return; // adapter doesn't support save
		const filename = slotFilename(conversationId, slotId);
		// llmStreamSaveSlot is per-stream in the binding API; the desktop
		// adapter currently saves the ctx-wide seq=0 state, so the stream
		// handle is informational. We pass the runner's most recent
		// stream id when available; 0n is the binding-level sentinel.
		binding.llmStreamSaveSlot({ stream: 0n, filename });
	}

	/** Restore a previously persisted KV state. Mirror of `persistConversationKv`. */
	async restoreConversationKv(
		conversationId: string,
		slotId: number,
	): Promise<boolean> {
		if (!this.session) return false;
		const { binding } = this.session;
		if (!binding.llmStreamRestoreSlot) return false;
		const filename = slotFilename(conversationId, slotId);
		binding.llmStreamRestoreSlot({ stream: 0n, filename });
		return true;
	}

	/**
	 * Pre-decode `promptPrefix` so the next `generate` against the same
	 * `cacheKey` skips re-prefill. Returns `false` when the prefix is
	 * empty or no session is loaded. The FFI runner serializes by
	 * `cacheKey` internally via the `slotInFlight` map.
	 */
	async prewarmConversation(
		promptPrefix: string,
		opts: { slotId: number; cacheKey: string },
	): Promise<boolean> {
		if (!this.session || promptPrefix.length === 0) return false;
		const { runner, tokenize, mtp, draftModelPath, loadConfig } = this.session;
		await runner.generateWithUsage({
			promptTokens: tokenize(promptPrefix),
			slotId: opts.slotId,
			cacheKey: opts.cacheKey,
			maxTokens: 0, // prefill-only: feed prompt, generate nothing
			temperature: 0,
			topP: 1,
			topK: 1,
			repeatPenalty: 1,
			draftMin: mtp?.draftMin ?? 0,
			draftMax: mtp?.draftMax ?? 0,
			draftModelPath,
			gpuLayers: loadConfig?.gpuLayers,
			cacheTypeK: loadConfig?.cacheTypeK,
			cacheTypeV: loadConfig?.cacheTypeV,
			contextSize: loadConfig?.contextSize,
		});
		return true;
	}

	currentRuntimeLoadConfig() {
		if (!this.session) return null;
		const loadConfig = this.session.loadConfig;
		return {
			modelId: null,
			modelPath: this.loadedPath,
			contextSize: loadConfig?.contextSize ?? null,
			cacheTypeK: loadConfig?.cacheTypeK ?? null,
			cacheTypeV: loadConfig?.cacheTypeV ?? null,
			gpuLayers:
				typeof loadConfig?.gpuLayers === "number" ? loadConfig.gpuLayers : null,
			parallel: this.parallelSlots(),
			binaryPath: null,
			backend: this.id,
			mtp: this.session.mtp
				? {
						specType: "draft-mtp" as const,
						draftMin: this.session.mtp.draftMin,
						draftMax: this.session.mtp.draftMax,
					}
				: null,
		};
	}

	/**
	 * True when Eliza-1 native MTP is active for the loaded target model.
	 * Covers both shapes: embedded-draft-head MTP (draft head embedded in
	 * the text GGUF, `draftModelPath` null) and separate-drafter MTP.
	 */
	mtpEnabled(): boolean {
		return Boolean(this.session?.mtp);
	}

	/**
	 * Parallel-slot pool size. Routed to the runtime's ctx pool when one
	 * exists; defaults to 1 otherwise.
	 */
	parallelSlots(): number {
		return this.runtime.parallelSlots?.() ?? 1;
	}

	/**
	 * Grow or shrink the runtime's ctx pool to `target` slots. Returns
	 * false when the runtime has no pool surface (in which case parallel
	 * resize is ignored — the conversation registry tolerates
	 * fixed 1-slot operation).
	 */
	async resizeParallel(target: number): Promise<boolean> {
		if (!this.runtime.resizeParallel) return false;
		return this.runtime.resizeParallel(target);
	}

	/**
	 * Vision describe via mmproj. Requires:
	 *   - The shim built with `-DELIZA_ENABLE_VISION=1` (ELIZA_ENABLE_VISION=1
	 *     at the build script env). When absent the runtime throws an
	 *     actionable error.
	 *   - `plan.overrides.mmprojPath` was passed at load time so the
	 *     adapter knows which mmproj GGUF to feed clip.
	 */
	async describeImage(args: {
		bytes: Uint8Array;
		mimeType?: string;
		prompt?: string;
		maxTokens?: number;
		temperature?: number;
		signal?: AbortSignal;
		/** Per-token callback — when set + the runtime supports streaming vision,
		 * the description is decoded token-by-token through the same pipe as chat. */
		onTextChunk?: (chunk: string) => void | Promise<void>;
		maxTokensPerStep?: number;
	}): Promise<{ text: string; projectorMs?: number; decodeMs?: number }> {
		if (!this.session) {
			throw new Error(
				"[ffi-streaming-backend] describeImage before load — no session acquired",
			);
		}
		if (!this.session.mmprojPath) {
			throw new Error(
				"[ffi-streaming-backend] describeImage: no mmproj GGUF loaded for this session. " +
					"Pass `overrides.mmprojPath` in the BackendPlan when activating a vision-capable bundle.",
			);
		}
		// The runtime adapter has visionSupported() + describeImage(args).
		// We re-shape `bytes` → `imageBytes` and merge in the resolved
		// mmprojPath; the rest of args pass through unchanged.
		const runtime = this.runtime as FfiBackendRuntime & {
			describeImage?: (args: {
				imageBytes: Uint8Array;
				mmprojPath: string;
				prompt?: string;
				maxTokens?: number;
				temperature?: number;
				signal?: AbortSignal;
				onTextChunk?: (chunk: string) => void | Promise<void>;
				maxTokensPerStep?: number;
			}) => Promise<{ text: string; projectorMs?: number; decodeMs?: number }>;
		};
		if (!runtime.describeImage) {
			throw new Error(
				"[ffi-streaming-backend] runtime lacks describeImage support",
			);
		}
		return runtime.describeImage({
			imageBytes: args.bytes,
			mmprojPath: this.session.mmprojPath,
			prompt: args.prompt,
			maxTokens: args.maxTokens,
			temperature: args.temperature,
			signal: args.signal,
			onTextChunk: args.onTextChunk,
			maxTokensPerStep: args.maxTokensPerStep,
		});
	}

	currentMmprojPath(): string | null {
		return this.session?.mmprojPath ?? null;
	}
}

/**
 * Conversation-keyed slot file layout. Mirrors `cache-bridge.ts`'s
 * `slotSavePath` so an `ELIZA_INFERENCE_BACKEND=http` opt-out can resume
 * an FFI-saved conversation and vice-versa once the file formats align.
 */
function slotFilename(conversationId: string, slotId: number): string {
	return `${conversationId}__slot${slotId}.kv`;
}

/** Size of a regular file on disk, or null when it cannot be stat-ed. */
function fileSizeOrNull(filePath: string): number | null {
	try {
		const stat = statSync(filePath);
		return stat.isFile() ? stat.size : null;
	} catch {
		return null;
	}
}
