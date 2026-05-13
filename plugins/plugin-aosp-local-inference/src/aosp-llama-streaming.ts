/**
 * AOSP streaming-LLM FFI binding.
 *
 * Wraps the C ABI declared in
 * `packages/app-core/scripts/omnivoice-fuse/ffi-streaming-llm.h` and
 * adapts it to the JS-side surface expected by
 * `FfiStreamingRunner` (in `@elizaos/app-core`).  Same shape as the
 * desktop FFI binding in `voice/ffi-bindings.ts` — the runner does not
 * know or care which platform is underneath.
 *
 * Why this lives in the AOSP plugin and NOT in app-core:
 *   - `bun:ffi` is the only path to `libllama.so` on the AOSP agent
 *     process; we already dlopen it from `aosp-llama-adapter.ts` to
 *     bind the single-model `llama_*` symbols.
 *   - The fused `libelizainference.so` also lives in the same per-ABI
 *     asset dir on Android (`agent/{abi}/libelizainference.so`), built
 *     by `scripts/elizaos/compile-libelizainference.mjs` (the fused
 *     pipeline driven by `cmake-graft.mjs`).  Putting the binding here
 *     keeps "all native libllama.cpp on Android" co-located.
 *   - It lets us register the same `FfiStreamingRunnerFactory` shape
 *     `aosp-dflash-adapter.ts` already imports from app-core — so the
 *     existing dispatcher stitches mobile streaming through the same
 *     entry point the desktop runner uses.
 *
 * Important: this module does NOT load a model itself.  It binds the
 * streaming-LLM symbols on top of a `libelizainference` handle that was
 * opened by the shared voice-lifecycle FFI service.  When the streaming
 * symbols are missing (older fused build) the loader returns null and
 * the dispatcher falls back to the non-streaming `aosp-llama-adapter.ts`
 * path on text turns.  DFlash on mobile then degrades to "target-only,
 * no speculative" (see `aosp-dflash-adapter.ts`).
 */

import { logger } from "@elizaos/core";

/* -------------------------------------------------------------------- */
/* JS-visible types — kept in sync with app-core's ffi-bindings.ts.     */
/* -------------------------------------------------------------------- */

/**
 * Opaque pointer to a streaming-LLM session.  Numeric on `bun:ffi`
 * (returned as `bigint`); never inspected on the JS side.
 */
export type AospLlmStreamHandle = bigint;

/** Pointer to the parent `EliInferenceContext`. */
export type AospInferenceContextHandle = bigint;

export interface AospLlmStreamConfig {
  maxTokens: number;
  temperature: number;
  topP: number;
  topK: number;
  repeatPenalty: number;
  slotId: number;
  promptCacheKey: string | null;
  draftMin: number;
  draftMax: number;
  dflashDrafterPath: string | null;
  disableThinking: boolean;
}

/**
 * One streaming step surfaced to the runner.  `tokens` carries the
 * accepted-batch token ids (>= 1 — > 1 only under DFlash speculative
 * decoding when the verifier accepted multiple drafts on this step).
 * `text` is the detokenised UTF-8 for those tokens concatenated.  `done`
 * is true only on the final step (EOS / EOG / `max_tokens` cap).
 */
export interface AospLlmStreamStep {
  tokens: number[];
  text: string;
  done: boolean;
  drafterDrafted: number;
  drafterAccepted: number;
}

/**
 * Surface the streaming runner factory in `app-core` expects.  Same
 * shape as the desktop `ElizaInferenceFfi.llmStream*` slice.  Methods
 * are optional only on the `ElizaInferenceFfi` parent because older
 * builds may omit them; here every method MUST be present (the loader
 * returns null when any are missing).
 */
export interface AospStreamingLlmBinding {
  /** True only when the underlying .so reports streaming-LLM support. */
  llmStreamSupported(): boolean;
  llmStreamOpen(args: {
    ctx: AospInferenceContextHandle;
    config: AospLlmStreamConfig;
  }): AospLlmStreamHandle;
  llmStreamPrefill(args: {
    stream: AospLlmStreamHandle;
    tokens: Int32Array;
  }): void;
  llmStreamNext(args: {
    stream: AospLlmStreamHandle;
    maxTokensPerStep?: number;
    maxTextBytes?: number;
  }): AospLlmStreamStep;
  llmStreamCancel(stream: AospLlmStreamHandle): void;
  llmStreamSaveSlot(args: {
    stream: AospLlmStreamHandle;
    filename: string;
  }): void;
  llmStreamRestoreSlot(args: {
    stream: AospLlmStreamHandle;
    filename: string;
  }): void;
  llmStreamClose(stream: AospLlmStreamHandle): void;
}

/* -------------------------------------------------------------------- */
/* Async-iterable façade.  Same contract a caller would see if they used*/
/* the bare `ElizaInferenceFfi` slice from app-core — this is here so   */
/* AOSP-side callers that want to iterate without registering a chunk   */
/* callback (e.g. a UI-side token replayer) have a JS-idiomatic API.    */
/* -------------------------------------------------------------------- */

export interface AospStreamingLlmGenerateArgs {
  ctx: AospInferenceContextHandle;
  config: AospLlmStreamConfig;
  promptTokens: Int32Array;
  signal?: AbortSignal;
  /** Per-step text callback. */
  onTextChunk?: (chunk: string) => void | Promise<void>;
  /** Per-step max-tokens cap.  Defaults to 32 — matches upstream `n_predict` chunks. */
  maxTokensPerStep?: number;
  /** Per-step text buffer cap.  Defaults to 1024 bytes. */
  maxTextBytes?: number;
}

export interface AospStreamingLlmResult {
  text: string;
  steps: number;
  drafted: number;
  accepted: number;
}

const DEFAULT_MAX_TOKENS_PER_STEP = 32;
const DEFAULT_MAX_TEXT_BYTES = 1024;

/**
 * Run one streaming generate against the binding.  Mirrors
 * `FfiStreamingRunner.generateWithUsage` but lives in the plugin so the
 * AOSP build can use it without depending on `@elizaos/app-core` at
 * compile time.  When the dispatcher routes through the shared voice
 * lifecycle service, the parent `FfiStreamingRunner` is preferred — this
 * is for direct callers (text-only UI surfaces, e2e probes).
 */
export async function streamGenerate(
  binding: AospStreamingLlmBinding,
  args: AospStreamingLlmGenerateArgs,
): Promise<AospStreamingLlmResult> {
  if (!binding.llmStreamSupported()) {
    throw new Error(
      "[aosp-llama-streaming] streamGenerate called on a binding that " +
        "reports llmStreamSupported() === false. Rebuild libelizainference " +
        "against the current ffi-streaming-llm.h.",
    );
  }

  const stream = binding.llmStreamOpen({
    ctx: args.ctx,
    config: args.config,
  });

  let abortListener: (() => void) | null = null;
  if (args.signal) {
    if (args.signal.aborted) {
      binding.llmStreamCancel(stream);
      binding.llmStreamClose(stream);
      throw new Error("[aosp-llama-streaming] aborted before start");
    }
    abortListener = () => {
      binding.llmStreamCancel(stream);
    };
    args.signal.addEventListener("abort", abortListener, { once: true });
  }

  const chunks: string[] = [];
  let steps = 0;
  let drafted = 0;
  let accepted = 0;
  try {
    binding.llmStreamPrefill({ stream, tokens: args.promptTokens });
    while (true) {
      if (args.signal?.aborted) {
        binding.llmStreamCancel(stream);
        throw new Error("[aosp-llama-streaming] aborted");
      }
      const step = binding.llmStreamNext({
        stream,
        maxTokensPerStep: args.maxTokensPerStep ?? DEFAULT_MAX_TOKENS_PER_STEP,
        maxTextBytes: args.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES,
      });
      steps += 1;
      drafted += step.drafterDrafted;
      accepted += step.drafterAccepted;
      if (step.text.length > 0) {
        chunks.push(step.text);
        if (args.onTextChunk) {
          await args.onTextChunk(step.text);
        }
      }
      if (step.done) break;
    }
  } finally {
    if (abortListener && args.signal) {
      args.signal.removeEventListener("abort", abortListener);
    }
    binding.llmStreamClose(stream);
  }

  return { text: chunks.join(""), steps, drafted, accepted };
}

/**
 * Async-iterable variant: yields each non-empty step in order.  Useful
 * when the consumer needs token-grained control (e.g. mobile UI driving
 * its own phrase chunker off accept events).  Internally identical to
 * `streamGenerate` minus the aggregation.
 */
export async function* streamGenerateIterable(
  binding: AospStreamingLlmBinding,
  args: AospStreamingLlmGenerateArgs,
): AsyncIterable<AospLlmStreamStep> {
  if (!binding.llmStreamSupported()) {
    throw new Error(
      "[aosp-llama-streaming] streamGenerateIterable called on a binding " +
        "that reports llmStreamSupported() === false. Rebuild libelizainference.",
    );
  }
  const stream = binding.llmStreamOpen({
    ctx: args.ctx,
    config: args.config,
  });

  let abortListener: (() => void) | null = null;
  if (args.signal) {
    if (args.signal.aborted) {
      binding.llmStreamCancel(stream);
      binding.llmStreamClose(stream);
      throw new Error("[aosp-llama-streaming] aborted before start");
    }
    abortListener = () => {
      binding.llmStreamCancel(stream);
    };
    args.signal.addEventListener("abort", abortListener, { once: true });
  }

  try {
    binding.llmStreamPrefill({ stream, tokens: args.promptTokens });
    while (true) {
      if (args.signal?.aborted) {
        binding.llmStreamCancel(stream);
        throw new Error("[aosp-llama-streaming] aborted");
      }
      const step = binding.llmStreamNext({
        stream,
        maxTokensPerStep: args.maxTokensPerStep ?? DEFAULT_MAX_TOKENS_PER_STEP,
        maxTextBytes: args.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES,
      });
      yield step;
      if (step.done) break;
    }
  } finally {
    if (abortListener && args.signal) {
      args.signal.removeEventListener("abort", abortListener);
    }
    binding.llmStreamClose(stream);
  }
}

/* -------------------------------------------------------------------- */
/* Capability struct passed up to the runtime.                          */
/* -------------------------------------------------------------------- */

/**
 * Per-platform / per-build capability summary surfaced to the runtime by
 * the FFI layer.  The runtime uses this to:
 *   - decide whether to register the FFI streaming runner factory at all
 *     (`streamingLlm === false` → fall back to single-model FFI),
 *   - decide whether the DFlash adapter should attempt speculative
 *     decoding (`dflashSupported === false` → run target-only),
 *   - choose between the omnivoice streaming path and the batch path,
 *   - hide multi-modal-projection (mmproj) UI elements on phones that
 *     don't carry the projector.
 *
 * `mmprojSupported` will typically be false on phones (the projector
 * pushes peak RAM past the 8GB / 12GB phone budget on Eliza-1).  The
 * field is here so a richer phone (e.g. desktop chassis) can flip it.
 */
export interface AospInferenceCapabilities {
  streamingLlm: boolean;
  dflashSupported: boolean;
  omnivoiceStreaming: boolean;
  mmprojSupported: boolean;
}

/**
 * Probe `binding` + the runtime platform for what the underlying
 * libelizainference build actually supports.  Cheap — does NOT load a
 * model.  Safe to call from the runtime startup path.
 */
export function probeAospCapabilities(
  binding: Pick<AospStreamingLlmBinding, "llmStreamSupported"> | null,
  /** Platform tag, "android" | "ios" | "other".  Pass from the caller so the
   *  probe stays testable without importing Capacitor here. */
  platform: "android" | "ios" | "other",
  /** Whether the fused build's omnivoice streaming surface is wired. */
  omnivoiceStreaming: boolean,
): AospInferenceCapabilities {
  const streamingLlm = binding?.llmStreamSupported() ?? false;
  // Mobile builds today don't carry the drafter weights mapped — DFlash
  // requires both target + drafter resident.  Marking dflashSupported
  // off on mobile lets the runtime emit a single accept event per token
  // (no rejects) instead of routing through the verifier callback.
  // Desktop keeps its native verifier-callback drive.
  const dflashSupported = streamingLlm && platform === "other";
  // mmproj almost never fits on a phone alongside the chat model; let
  // the runtime opt the build in explicitly when it does.
  const mmprojSupported = platform === "other";
  return {
    streamingLlm,
    dflashSupported,
    omnivoiceStreaming,
    mmprojSupported,
  };
}

/* -------------------------------------------------------------------- */
/* Diagnostics                                                          */
/* -------------------------------------------------------------------- */

/**
 * Log a one-line summary of the resolved capabilities.  Called by the
 * AOSP bootstrap at boot so trajectory dumps have a single grep target
 * for "what does this device's local-inference stack expose".
 */
export function logCapabilities(caps: AospInferenceCapabilities): void {
  logger.info(
    `[aosp-llama-streaming] caps: streamingLlm=${caps.streamingLlm} ` +
      `dflashSupported=${caps.dflashSupported} ` +
      `omnivoiceStreaming=${caps.omnivoiceStreaming} ` +
      `mmprojSupported=${caps.mmprojSupported}`,
  );
}
