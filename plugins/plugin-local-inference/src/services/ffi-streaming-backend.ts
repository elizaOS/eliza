/**
 * In-process FFI streaming backend adapter.
 *
 * Implements `LocalInferenceBackend` so it can be slotted into
 * `BackendDispatcher` as a peer of `LlamaServerBackend` (the subprocess+HTTP
 * `dflash-server` path) and `NodeLlamaCppBackend` (the in-process N-API
 * binding). When the dispatcher's `decideBackend()` returns `"llama-server"`
 * AND `selectBackend()` (`backend-selector.ts`) picks `"ffi-streaming"`,
 * the dispatcher routes load/generate/unload through here instead of the
 * subprocess.
 *
 * STATUS — scaffolding only:
 *   This class is not yet constructed in production. The optional
 *   `ffiStreaming` / `probeFfiActive` parameters on `BackendDispatcher` are
 *   left undefined by `engine.ts`, so the runtime continues to use the
 *   subprocess path unchanged. The architectural prerequisites for
 *   constructing a real `FfiBackendRuntime` (FFI context ownership decision,
 *   tokenizer access, slot-persistence capability probe) are documented in
 *   `plugins/plugin-local-inference/FFI_BACKEND_WIREUP_PLAN.md`.
 *
 * Once those land, `engine.ts` will construct this class with a real runtime
 * and pass it to `BackendDispatcher` — see step D of the wire-up plan.
 *
 * What this class deliberately does NOT do:
 *   - Own the FFI context. The `ElizaInferenceFfi` handle is created by the
 *     voice lifecycle service today; the runtime provider passed to this
 *     class is the seam where ownership gets resolved.
 *   - Implement `embed`. Vision describe, embedding, slot save/restore, and
 *     parallel-slot resize all live on `dflashLlamaServer` today and are
 *     called from `engine.ts` directly (bypassing the dispatcher). Until
 *     those are routed through the dispatcher AND the FFI runner gains
 *     parity for each, the dispatcher's existing
 *     `"Active backend does not implement embed"` throw is the right
 *     behavior — it surfaces the gap loudly rather than silently degrading.
 */

import type {
	BackendPlan,
	GenerateArgs,
	GenerateResult,
	LocalInferenceBackend,
} from "./backend";
import type { FfiStreamingRunner } from "./ffi-streaming-runner";
import type {
	LlmCtxHandle,
	LlmStreamingBinding,
} from "./llm-streaming-binding";

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
 * Two production implementations are expected:
 *   - libelizainference path → wraps `ElizaInferenceFfi` via
 *     `wrapElizaInferenceFfi()` from `services/llm-streaming-binding.ts`.
 *   - desktop libllama+shim path → mirrors the AOSP adapter pattern.
 *     Pending — see `FFI_BACKEND_WIREUP_PLAN.md` Step B.
 */
export interface FfiBackendRuntime {
	supported(): boolean;
	acquire(plan: BackendPlan): Promise<FfiBackendSession>;
	release(): Promise<void>;
	/**
	 * Optional parallel-slot pool surface. When the runtime exposes a
	 * ctx pool (the desktop libllama path does), `parallelSlots()`
	 * reports the live count and `resizeParallel(N)` grows/shrinks it.
	 * Runtimes without a pool report 1 and treat resize as no-op.
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
	 * Drafter GGUF path for speculative decoding, when the bundle ships one
	 * and the loaded binding supports DFlash. `null` disables speculative
	 * decoding for this session.
	 */
	readonly drafterPath: string | null;
	/**
	 * Multimodal projector (mmproj) GGUF path for vision describe. Resolved
	 * from `plan.overrides.mmprojPath` at acquire time. `null` disables
	 * vision — `describeImage` then throws an actionable error.
	 */
	readonly mmprojPath: string | null;
}

/**
 * Adapter that satisfies `LocalInferenceBackend` by delegating to
 * `FfiStreamingRunner`. The `id` is intentionally `"llama-server"` because
 * the dispatcher's `decideBackend()` returns `"llama-server"` to mean
 * "the kernel-required path", and this class is the in-process variant of
 * that path. The transport choice (FFI vs subprocess) is orthogonal and
 * lives in `selectBackend()`.
 */
export class FfiStreamingBackend implements LocalInferenceBackend {
	readonly id = "llama-server" as const;

	private session: FfiBackendSession | null = null;
	private loadedPath: string | null = null;

	constructor(private readonly runtime: FfiBackendRuntime) {}

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
		this.session = await this.runtime.acquire(plan);
		this.loadedPath = plan.modelPath;
	}

	async unload(): Promise<void> {
		this.session = null;
		this.loadedPath = null;
		await this.runtime.release();
	}

	async generate(args: GenerateArgs): Promise<GenerateResult> {
		if (!this.session) {
			throw new Error(
				"[ffi-streaming-backend] generate() called before load() — " +
					"the FFI session has not been acquired.",
			);
		}
		const { runner, tokenize, drafterPath } = this.session;
		const result = await runner.generateWithUsage({
			promptTokens: tokenize(args.prompt),
			slotId: -1,
			cacheKey: args.cacheKey,
			maxTokens: args.maxTokens ?? 2048,
			temperature: args.temperature ?? 0.7,
			topP: args.topP ?? 0.9,
			topK: 40,
			repeatPenalty: 1.1,
			draftMin: 0,
			draftMax: 0,
			dflashDrafterPath: drafterPath,
			signal: args.signal,
			onTextChunk: args.onTextChunk,
			onVerifierEvent: args.onVerifierEvent,
		});
		return result.text;
	}

	// === Optional `LocalInferenceBackend` methods routed through the runner.

	/**
	 * Persist the active session's KV state to a per-conversation file.
	 * v1 uses `llama_state_seq_save_file` against seq_id=0 — see
	 * `desktop-llama-adapter.ts`'s `saveSlot`. The on-disk file path
	 * mirrors `dflash-server.ts`'s conversation-keyed slot layout
	 * (`<cacheDir>/<conversationId>/<slotId>.kv`) so a switch between
	 * FFI and subprocess can resume each other's slots — once both
	 * paths agree on the file format.
	 */
	async persistConversationKv(
		conversationId: string,
		slotId: number,
	): Promise<void> {
		if (!this.session) return; // no-op when not loaded
		const { binding } = this.session;
		if (!binding.llmStreamSaveSlot) return; // adapter doesn't support save
		const filename = slotFilename(conversationId, slotId);
		// llmStreamSaveSlot is per-stream in the binding API; the desktop
		// adapter currently saves the ctx-wide seq=0 state, so the stream
		// handle is informational. We pass the runner's most recent
		// stream id when available — empty-bigint placeholder otherwise.
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
		const { runner, tokenize, drafterPath } = this.session;
		await runner.generateWithUsage({
			promptTokens: tokenize(promptPrefix),
			slotId: opts.slotId,
			cacheKey: opts.cacheKey,
			maxTokens: 0, // prefill-only: feed prompt, generate nothing
			temperature: 0,
			topP: 1,
			topK: 1,
			repeatPenalty: 1,
			draftMin: 0,
			draftMax: 0,
			dflashDrafterPath: drafterPath,
		});
		return true;
	}

	/**
	 * Speculative-decoding accessors. The FFI runtime resolves the drafter
	 * path from the catalog's `runtime.dflash` block and attaches it
	 * lazily on the first `llmStreamOpen` call. `drafterEnabled()` reflects
	 * whether the session was wired with a drafter path; the adapter
	 * decides per-generation whether to actually attach based on the
	 * `dflashDrafterPath` passed in `LlmStreamConfig`.
	 */
	drafterEnabled(): boolean {
		return (
			this.session?.drafterPath !== null &&
			this.session?.drafterPath !== undefined
		);
	}

	loadedDrafterModelPath(): string | null {
		return this.session?.drafterPath ?? null;
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
	 * resize is silently a no-op — the conversation registry tolerates
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
		const runtime = this.runtime as unknown as {
			describeImage?: (args: {
				imageBytes: Uint8Array;
				mmprojPath: string;
				prompt?: string;
				maxTokens?: number;
				temperature?: number;
				signal?: AbortSignal;
			}) => Promise<{ text: string; projectorMs?: number; decodeMs?: number }>;
		};
		if (!runtime.describeImage) {
			throw new Error(
				"[ffi-streaming-backend] runtime does not implement describeImage",
			);
		}
		return runtime.describeImage({
			imageBytes: args.bytes,
			mmprojPath: this.session.mmprojPath,
			prompt: args.prompt,
			maxTokens: args.maxTokens,
			temperature: args.temperature,
			signal: args.signal,
		});
	}

	currentMmprojPath(): string | null {
		return this.session?.mmprojPath ?? null;
	}

	// `embed` still not implemented — text-generation embeddings are a
	// separate kernel surface that hasn't been wired through this backend.
}

/**
 * Conversation-keyed slot file layout. Mirrors `cache-bridge.ts`'s
 * `slotSavePath` so an `ELIZA_INFERENCE_BACKEND=http` opt-out can resume
 * an FFI-saved conversation and vice-versa once the file formats align.
 */
function slotFilename(conversationId: string, slotId: number): string {
	return `${conversationId}__slot${slotId}.kv`;
}
