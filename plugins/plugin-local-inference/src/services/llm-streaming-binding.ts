/**
 * Narrow streaming-LLM binding.
 *
 * `FfiStreamingRunner` (`services/ffi-streaming-runner.ts`) needs only a
 * narrow slice of the FFI to run text generation, not the full
 * `ElizaInferenceFfi` surface (TTS + ASR + VAD + mmap regions + the entire
 * fused libelizainference). That full surface implies a *bundle-anchored*
 * runtime — libelizainference owns a context built from a bundle root, not a
 * single GGUF — and ~25 methods that have nothing to do with LLM streaming.
 *
 * This file extracts the actual contract the runner depends on: the seven
 * `llmStream*` methods plus the (optional) two slot save/restore methods.
 * Both libelizainference (via a tiny adapter) and the desktop
 * libllama + eliza-llama-shim path (built by `build-llama-cpp-desktop-dylib.mjs`,
 * mirroring the AOSP adapter pattern) can implement this narrow contract
 * without dragging in TTS/ASR.
 *
 * See `plugins/plugin-local-inference/FFI_BACKEND_WIREUP_PLAN.md` Step B
 * for the desktop adapter follow-up that implements this interface against
 * the libllama symbols.
 */

import type {
	ElizaInferenceContextHandle,
	ElizaInferenceFfi,
	LlmStreamConfig,
	LlmStreamHandle,
	LlmStreamStep,
} from "./voice/ffi-bindings";

/**
 * Opaque per-context handle. For libelizainference this is the
 * `ElizaInferenceContextHandle` (a bigint pointer to the bundle context).
 * For the desktop libllama path it's a bigint pointer to a per-model
 * llama_context. The runner only needs to pass it through to
 * `llmStreamOpen`.
 */
export type LlmCtxHandle = ElizaInferenceContextHandle;

/**
 * The streaming-LLM contract `FfiStreamingRunner` consumes. Methods
 * mirror the C ABI declared in `tools/omnivoice/include/eliza-inference-ffi.h`
 * (the `eliza_inference_llm_stream_*` surface), but the binding doesn't have
 * to come from libelizainference — any implementation that satisfies this
 * interface works.
 *
 * Slot save/restore are optional because the desktop libllama path
 * does not expose `llama_state_seq_save_file` / `_load_file` through
 * the shim yet. The runner already guards both methods via
 * `if (this.ffi.llmStreamSaveSlot === undefined) throw ...`.
 */
export interface LlmStreamingBinding {
	/** Probe — must return `true` for the binding to be usable by the runner. */
	llmStreamSupported(): boolean;
	/**
	 * Open a streaming-LLM session against `ctx`. Failure throws an
	 * implementation-specific error (`VoiceLifecycleError` for
	 * libelizainference). Close exactly once via `llmStreamClose`.
	 */
	llmStreamOpen(args: {
		ctx: LlmCtxHandle;
		config: LlmStreamConfig;
	}): LlmStreamHandle;
	/** Feed a batch of pre-tokenized prompt tokens before the first `next`. */
	llmStreamPrefill(args: { stream: LlmStreamHandle; tokens: Int32Array }): void;
	/**
	 * Pull the next streaming step. `step.done === true` is the final step.
	 * Implementations may bound the step by `maxTokensPerStep` /
	 * `maxTextBytes`; defaults are runner-side.
	 */
	llmStreamNext(args: {
		stream: LlmStreamHandle;
		maxTokensPerStep?: number;
		maxTextBytes?: number;
	}): LlmStreamStep;
	/** Cancel in-flight generation; the next `_next` returns CANCELLED. */
	llmStreamCancel(stream: LlmStreamHandle): void;
	/** Close + free a streaming-LLM session. Idempotent on already-closed handles. */
	llmStreamClose(stream: LlmStreamHandle): void;
	/** Optional — persist the session's slot KV state to disk. */
	llmStreamSaveSlot?(args: { stream: LlmStreamHandle; filename: string }): void;
	/** Optional — restore a previously-saved slot KV file. */
	llmStreamRestoreSlot?(args: {
		stream: LlmStreamHandle;
		filename: string;
	}): void;
}

/**
 * Wrap a full `ElizaInferenceFfi` as a narrow `LlmStreamingBinding`.
 * The libelizainference path already implements the `llmStream*` methods
 * as optional properties; this adapter promotes them to required and
 * throws if the loaded library is too old to expose them.
 *
 * Usage:
 *   const binding = wrapElizaInferenceFfi(ffi);
 *   const runner = new FfiStreamingRunner(binding, ctxHandle);
 */
export function wrapElizaInferenceFfi(
	ffi: ElizaInferenceFfi,
): LlmStreamingBinding {
	if (
		typeof ffi.llmStreamSupported !== "function" ||
		!ffi.llmStreamSupported() ||
		typeof ffi.llmStreamOpen !== "function" ||
		typeof ffi.llmStreamPrefill !== "function" ||
		typeof ffi.llmStreamNext !== "function" ||
		typeof ffi.llmStreamCancel !== "function" ||
		typeof ffi.llmStreamClose !== "function"
	) {
		throw new Error(
			"[llm-streaming-binding] The loaded libelizainference does not expose " +
				"the streaming-LLM symbol set (llmStreamSupported/Open/Prefill/Next/" +
				"Cancel/Close). Rebuild the omnivoice fuse against the current " +
				"eliza-inference-ffi.h (verify-fused-symbols requires this set).",
		);
	}
	// Narrowed function references so the returned object types are
	// non-optional even though the source surface declares them
	// optional.
	const open = ffi.llmStreamOpen;
	const prefill = ffi.llmStreamPrefill;
	const next = ffi.llmStreamNext;
	const cancel = ffi.llmStreamCancel;
	const close = ffi.llmStreamClose;
	return {
		llmStreamSupported: () => true,
		llmStreamOpen: open,
		llmStreamPrefill: prefill,
		llmStreamNext: next,
		llmStreamCancel: cancel,
		llmStreamClose: close,
		llmStreamSaveSlot: ffi.llmStreamSaveSlot,
		llmStreamRestoreSlot: ffi.llmStreamRestoreSlot,
	};
}
