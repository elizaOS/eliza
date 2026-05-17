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

import { FfiStreamingRunner } from "./ffi-streaming-runner";
import type {
	BackendPlan,
	GenerateArgs,
	GenerateResult,
	LocalInferenceBackend,
} from "./backend";
import type {
	ElizaInferenceContextHandle,
	ElizaInferenceFfi,
} from "./voice/ffi-bindings";

/**
 * Constructor-injected adapter that resolves the FFI context, runner, and
 * tokenizer for a given load. Two responsibilities:
 *
 *   1. Decide whether the FFI path is viable on the current binding
 *      (`supported()`). Mirror of `llmStreamSupported()` plus any
 *      higher-level constraints (e.g. the loaded `libelizainference`
 *      version exports the required symbols).
 *   2. Lifecycle: `acquire(plan)` returns the FFI runner ready for
 *      `generate()` against the requested model, plus a tokenizer that
 *      matches that model's vocab. `release()` tears everything down.
 *
 * Whether the runtime owns its own FFI context or borrows the voice
 * lifecycle's is an open question — see the wire-up plan, section "FFI
 * context ownership". Either implementation satisfies this interface.
 */
export interface FfiBackendRuntime {
	supported(): boolean;
	acquire(plan: BackendPlan): Promise<FfiBackendSession>;
	release(): Promise<void>;
}

/**
 * Result of `FfiBackendRuntime.acquire()` — a live FFI session bound to a
 * specific loaded model.
 */
export interface FfiBackendSession {
	readonly ffi: ElizaInferenceFfi;
	readonly ctx: ElizaInferenceContextHandle;
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
	 * and the loaded `libelizainference` supports DFlash. `null` disables
	 * speculative decoding for this session.
	 */
	readonly drafterPath: string | null;
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

	// Deliberately no `embed()`. The dispatcher throws with a clear message
	// pointing at the gap. Same applies to vision describe, slot save/restore,
	// and parallel-slot resize — those go through `dflashLlamaServer` direct
	// calls in `engine.ts` today and need separate routing work before the
	// FFI default can flip; see `plugins/plugin-local-inference/FFI_BACKEND_WIREUP_PLAN.md`.
}
