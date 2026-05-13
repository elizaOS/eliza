/**
 * TypeScript-side ABI surface for the in-process FFI streaming LLM path.
 *
 * This file mirrors the C header at
 * `packages/inference/llama.cpp/omnivoice/src/ffi-streaming.h` — the
 * function names are the same so that bun:ffi symbol resolution uses the
 * exact C exports without any aliasing.
 *
 * Rationale for a separate ABI module
 * ────────────────────────────────────
 * `ffi-streaming-runner.ts` depends on the `ElizaInferenceFfi` handle from
 * `voice/ffi-bindings.ts`, which in turn is tied to the omnivoice-fused
 * build of `libelizainference`. That handle carries TTS, ASR, embedding,
 * and streaming-LLM symbols together. The ABI declared here is the
 * *streaming-LLM-only* slice that the mobile bootstrap needs to reason
 * about independently — it does not assume the full fused binary is
 * loaded. Callers that already have an `ElizaInferenceFfi` can implement
 * `FfiLlmStreamingAbi` as a thin wrapper; callers that only have the
 * llama.cpp-only `libelizainference.so` (e.g. the Android AOSP bootstrap
 * before omnivoice ships) can implement it directly.
 *
 * DFlash phasing
 * ──────────────
 * Phase 1 — target model only. The `FfiLlmStreamingAbi` alone is
 * sufficient: open a single-model streaming session, prefill, generate,
 * cancel, close. No drafter weights required.
 *
 * Phase 2 — speculative decoding. When `MobileInferenceCapabilities.
 * dflashSupported` is `true`, swap to `FfiDflashStreamingAbi` which opens
 * a paired drafter + verifier session and runs the speculative decode loop
 * on-device. The two ABI surfaces share the same `FfiLlmHandle` brand so
 * the dispatcher (`runtime-dispatcher.ts`) sees a uniform handle type.
 *
 * iOS XCFramework gap
 * ───────────────────
 * The ABI is defined here, the C header is frozen, but the iOS
 * XCFramework that re-exports these symbols through the Swift bridge has
 * not shipped yet. `loadIosStreamingLlmBinding()` in
 * `ios-llama-streaming.ts` returns `null` until the XCFramework build
 * lands. See `docs/inference/ffi-streaming.md` §iOS XCFramework gap for
 * the current status.
 */

// ---------------------------------------------------------------------------
// Core handle types
// ---------------------------------------------------------------------------

/**
 * Opaque handle to an open streaming-LLM session. The underlying C value
 * is a pointer to a heap-allocated session struct; we brand it at the TS
 * layer to prevent accidental mixing with other handle types.
 *
 * Concrete implementations will typically alias this to `bigint` (the
 * bun:ffi representation of a C pointer) — but callers should treat it as
 * opaque.
 */
export interface FfiLlmHandle {
  readonly _brand: "FfiLlmHandle";
}

/**
 * Token callback fired from the generation background thread once per
 * decoded token (or once per speculative-accept batch in DFlash mode).
 *
 * `isDone` is `true` on the *last* invocation for a given generate call.
 * After `isDone` the handle remains open but must not be passed to
 * `generate` again until the caller re-prefills.
 *
 * The callback executes synchronously on the background thread the C
 * library uses for decoding — callers must not call any FFI method
 * back from inside the callback (the lock is not re-entrant).
 */
export type TokenCallback = (
  tokenId: number,
  tokenText: string,
  isDone: boolean,
) => void;

// ---------------------------------------------------------------------------
// Single-model streaming ABI
// ---------------------------------------------------------------------------

/**
 * C ABI surface for the in-process streaming LLM path.
 *
 * Function names match the C exports in `ffi-streaming.h` exactly; bun:ffi
 * resolves them by string match against the shared library symbol table.
 *
 * All methods are synchronous from the JS perspective (bun:ffi calls are
 * synchronous unless declared `nonblocking`). `generate` is the one
 * exception: it returns immediately after scheduling the background decode
 * loop and delivers results via `tokenCallback`.
 */
export interface FfiLlmStreamingAbi {
  /**
   * Open a streaming-LLM session against the model at `modelPath`.
   *
   * The model is memory-mapped into the process — this call may block
   * briefly on a cold filesystem. Subsequent calls with the same path
   * share the mmap region (the C library uses a ref-counted mmap cache).
   *
   * Returns an opaque handle on success, or `null` when:
   *   - the model file does not exist or cannot be read,
   *   - the device lacks the RAM required for `contextSizeTokens`,
   *   - `gpuLayers > 0` and the Metal / Vulkan device is unavailable.
   *
   * @param modelPath          Absolute path to a GGUF model file.
   * @param contextSizeTokens  KV cache size in tokens (must be power-of-two
   *                           aligned; the library rounds up if needed).
   * @param numThreads         CPU decode threads. 0 = auto-detect (uses
   *                           `eliza_inference_default_thread_count()`).
   * @param gpuLayers          Number of transformer layers to offload to
   *                           GPU. 0 = CPU only.
   */
  eliza_inference_llm_stream_open(
    modelPath: string,
    contextSizeTokens: number,
    numThreads: number,
    gpuLayers: number,
  ): FfiLlmHandle | null;

  /**
   * Prefill the KV cache with the supplied token ids.
   *
   * Blocks until all tokens are evaluated. On a large prompt this can
   * take several hundred milliseconds on CPU — callers should not invoke
   * on the main thread.
   *
   * @param handle        Active session from `open`.
   * @param promptTokens  Pre-tokenized prompt; row-major int32 ids.
   * @param slotId        KV slot index (0-based). Use -1 to allocate a
   *                      fresh slot; use 0..N-1 to pin a conversational
   *                      turn for KV reuse across multi-turn sessions.
   * @returns Number of tokens prefilled, or -1 on error (invalid handle,
   *          OOM, or KV cache exhausted).
   */
  eliza_inference_llm_stream_prefill(
    handle: FfiLlmHandle,
    promptTokens: Int32Array,
    slotId: number,
  ): number;

  /**
   * Start async token generation.
   *
   * The library spins up an internal worker thread (or reuses a pooled
   * one) and begins decoding. Each decoded token fires `tokenCallback`
   * from that thread. The final callback invocation has `isDone = true`.
   *
   * This call is non-blocking from the C caller's perspective: the C
   * function returns 0 as soon as the worker is scheduled. From the JS
   * perspective, callers should await the returned Promise — it resolves
   * after the final `isDone = true` callback fires so that the JS async
   * iterator can drain cleanly without a separate synchronisation
   * mechanism. Mock implementations fulfil this contract by resolving
   * the Promise after the last synthetic token; native FFI wrappers wrap
   * a completion event or condition variable.
   *
   * Calling `generate` on a handle that is already generating is a hard
   * error (returns -1 / rejects). Callers must wait for the Promise to
   * resolve (or call `cancel` and await the resulting `isDone` callback)
   * before re-using the handle.
   *
   * @param handle        Active session from `open`.
   * @param maxNewTokens  Budget cap. Generation stops at `maxNewTokens`
   *                      even if no EOS token was produced.
   * @param temperature   Softmax temperature. 0.0 = greedy.
   * @param topP          Nucleus sampling threshold (0.0–1.0).
   * @param tokenCallback Callback fired per token from the decode thread.
   * @returns Promise resolving to 0 on success, -1 on error.
   */
  eliza_inference_llm_stream_generate(
    handle: FfiLlmHandle,
    maxNewTokens: number,
    temperature: number,
    topP: number,
    tokenCallback: TokenCallback,
  ): number | Promise<number>;

  /**
   * Signal the active generation to stop at the next safe cancellation
   * point (after the current speculative batch is retired).
   *
   * This does NOT wait for the background thread to finish — the thread
   * fires a final `tokenCallback` with `isDone = true` shortly after the
   * cancel flag is observed. Callers that need to know the thread has
   * stopped must wait for that final callback.
   *
   * Calling `cancel` on a handle that is not currently generating is a
   * no-op.
   *
   * @param handle Active session from `open`.
   */
  eliza_inference_llm_stream_cancel(handle: FfiLlmHandle): void;

  /**
   * Release all resources associated with `handle`.
   *
   * Evicts the KV cache slots occupied by this session and releases the
   * mmap reference. The model's mmap region stays mapped until the ref
   * count reaches zero (i.e. all sessions against that path are closed).
   *
   * Calling `close` on a handle that is still generating is a hard error
   * — cancel first and wait for `isDone` before closing.
   *
   * @param handle Active session from `open`.
   */
  eliza_inference_llm_stream_close(handle: FfiLlmHandle): void;
}

// ---------------------------------------------------------------------------
// DFlash (speculative decoding) streaming ABI — Phase 2
// ---------------------------------------------------------------------------

/**
 * C ABI surface for paired drafter + verifier speculative decoding.
 *
 * Phase 2 only — the mobile runtime enables this path when
 * `MobileInferenceCapabilities.dflashSupported` is `true`. Phase 1
 * devices use `FfiLlmStreamingAbi` only (target model, no drafter).
 *
 * The DFlash session holds two model contexts internally:
 *   1. The *drafter* — a small, fast model that proposes `speculativeWindowSize`
 *      candidate tokens per step.
 *   2. The *verifier* — the full target model that accepts or rejects the
 *      drafter's proposals in one parallel evaluation batch.
 *
 * The token callback fires once per *accepted* token (after the verifier's
 * accept decision). Rejected tokens are silently discarded at the C layer;
 * the JS consumer always sees a stream of accepted tokens identical to
 * what a greedy target-only decode would have produced (assuming the
 * drafter and verifier share vocabulary and a compatible chat template).
 *
 * Method signatures mirror `FfiLlmStreamingAbi` exactly — only the `open`
 * argument list differs (adds drafter path + speculative window). This
 * keeps the dispatcher (`runtime-dispatcher.ts`) agnostic to which ABI is
 * in use.
 */
export interface FfiDflashStreamingAbi {
  /**
   * Open a paired drafter + verifier streaming session.
   *
   * Both models are mmap'd; the KV cache is sized to `contextSizeTokens`
   * for the verifier and proportionally smaller for the drafter (the C
   * library computes the drafter KV budget automatically from the
   * `speculativeWindowSize`).
   *
   * @param drafterModelPath     Absolute path to the drafter GGUF.
   * @param verifierModelPath    Absolute path to the verifier GGUF.
   * @param contextSizeTokens    Verifier KV size in tokens.
   * @param numThreads           CPU threads for verifier (drafter shares
   *                             the same thread pool).
   * @param gpuLayers            Verifier GPU layer count. The drafter
   *                             always runs on CPU in Phase 2 to avoid
   *                             competing for Metal/Vulkan resources.
   * @param speculativeWindowSize Number of drafter candidate tokens per
   *                             speculative step (1–16; 4 is a safe
   *                             starting point for mobile).
   * @returns Opaque session handle, or `null` on failure.
   */
  eliza_inference_dflash_stream_open(
    drafterModelPath: string,
    verifierModelPath: string,
    contextSizeTokens: number,
    numThreads: number,
    gpuLayers: number,
    speculativeWindowSize: number,
  ): FfiLlmHandle | null;

  /**
   * Prefill both the drafter and verifier KV caches in a single blocking
   * call. The verifier is prefilled first (it owns the ground-truth KV
   * state); the drafter is then fast-forwarded to match.
   *
   * Same contract as `FfiLlmStreamingAbi.eliza_inference_llm_stream_prefill`.
   */
  eliza_inference_dflash_stream_prefill(
    handle: FfiLlmHandle,
    promptTokens: Int32Array,
    slotId: number,
  ): number;

  /**
   * Start speculative-decoding generation. The token callback fires for
   * each verifier-accepted token — not for each drafter proposal.
   *
   * Same contract as `FfiLlmStreamingAbi.eliza_inference_llm_stream_generate`.
   */
  eliza_inference_dflash_stream_generate(
    handle: FfiLlmHandle,
    maxNewTokens: number,
    temperature: number,
    topP: number,
    tokenCallback: TokenCallback,
  ): number | Promise<number>;

  /**
   * Cancel an active DFlash generation at the next speculation boundary.
   * Same contract as `FfiLlmStreamingAbi.eliza_inference_llm_stream_cancel`.
   */
  eliza_inference_dflash_stream_cancel(handle: FfiLlmHandle): void;

  /**
   * Release both drafter and verifier sessions.
   * Same contract as `FfiLlmStreamingAbi.eliza_inference_llm_stream_close`.
   */
  eliza_inference_dflash_stream_close(handle: FfiLlmHandle): void;
}

// ---------------------------------------------------------------------------
// Mobile capability snapshot
// ---------------------------------------------------------------------------

/**
 * Device-side inference capability snapshot used by the mobile bootstrap
 * to decide which ABI path to activate at startup.
 *
 * Produced by `detectMobileCapabilities()`. The runtime re-probes on
 * every foreground resume (thermal / memory state can change while the
 * app is backgrounded).
 */
export type MobileInferenceCapabilities = {
  /**
   * True when the `eliza_inference_llm_stream_*` symbols are present in
   * the loaded `libelizainference` and `llmStreamSupported()` returns 1.
   * This is the gate for Phase 1 on-device inference.
   */
  streamingLlm: boolean;

  /**
   * True when `streamingLlm` is true AND the drafter GGUF is bundled AND
   * the device's thermal state is below `serious`. Gate for Phase 2
   * speculative decoding.
   */
  dflashSupported: boolean;

  /**
   * True when the `eliza_inference_tts_synthesize_stream` symbol is
   * present and `ttsStreamSupported()` returns 1. Gate for the OmniVoice
   * TTS streaming path.
   */
  omnivoiceStreaming: boolean;

  /**
   * Device-reported maximum KV context in tokens. Derived from available
   * device RAM minus the model weights footprint. The runtime clamps
   * user-configured context sizes to this value.
   *
   * 0 when `streamingLlm` is false (no context available).
   */
  maxContextTokens: number;

  /**
   * Number of transformer layers the device can offload to GPU/NPU at
   * the current thermal state without risking thermal throttling. 0 means
   * CPU-only execution. The runtime uses this as the initial `gpuLayers`
   * argument to `open`; it can be reduced dynamically when the thermal
   * state worsens mid-session.
   */
  recommendedGpuLayers: number;
};

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

/**
 * Derive a `MobileInferenceCapabilities` snapshot from an FFI binding.
 *
 * When `ffi` is `null` (e.g. in test environments, cloud-only builds, or
 * when the native library failed to load), all boolean flags are `false`
 * and numeric fields take safe zero defaults. This keeps the downstream
 * runtime uniform: it can always read the capability struct without
 * branching on "was an FFI loaded".
 *
 * When `ffi` is non-null, the function:
 *   1. Calls `llmStreamSupported()` to set `streamingLlm`.
 *   2. Sets `dflashSupported = false` for Phase 1 (drafter support
 *      detection requires a platform-specific bundle probe that is NOT
 *      part of this function; callers that have done the probe should set
 *      the field themselves after receiving the snapshot).
 *   3. Calls `ttsStreamSupported()` to set `omnivoiceStreaming`.
 *   4. Uses conservative device defaults for `maxContextTokens` and
 *      `recommendedGpuLayers` when the underlying library does not
 *      expose separate capability-query symbols (Phase 1 does not require
 *      them).
 *
 * @param ffi  A loaded FFI binding, or `null` for an all-false defaults
 *             snapshot.
 */
export function detectMobileCapabilities(
  ffi: FfiLlmStreamingAbi | null,
): MobileInferenceCapabilities {
  if (ffi === null) {
    return {
      streamingLlm: false,
      dflashSupported: false,
      omnivoiceStreaming: false,
      maxContextTokens: 0,
      recommendedGpuLayers: 0,
    };
  }

  // Phase 1: probe only the streaming-LLM surface. The FFI binding we
  // receive here is typed as `FfiLlmStreamingAbi`, which does not expose
  // ttsStreamSupported(). Cast to unknown to peek at the full binding if
  // it happens to be the fused omnivoice build — but don't fail if it
  // isn't; omnivoiceStreaming gracefully defaults to false.
  const anyFfi = ffi as unknown as Record<string, unknown>;

  const streamingLlm =
    typeof anyFfi.llmStreamSupported === "function"
      ? (anyFfi.llmStreamSupported as () => boolean)()
      : // If the binding doesn't expose a supported() query but was handed
        // to us at all, assume yes — the caller already verified the symbols
        // exist via `llmStreamOpen !== undefined` elsewhere.
        true;

  const omnivoiceStreaming =
    typeof anyFfi.ttsStreamSupported === "function"
      ? (anyFfi.ttsStreamSupported as () => boolean)()
      : false;

  // dflashSupported requires a drafter bundle probe that is not part of
  // this function's responsibility. Phase 1 always returns false here;
  // callers that have completed the bundle probe should OR in their result.
  const dflashSupported = false;

  // Conservative defaults for Phase 1. Devices with more RAM will
  // override these through the platform-specific capability probe once
  // the full `InferenceCapabilities` path is unified.
  const maxContextTokens = streamingLlm ? 2048 : 0;
  const recommendedGpuLayers = 0;

  return {
    streamingLlm,
    dflashSupported,
    omnivoiceStreaming,
    maxContextTokens,
    recommendedGpuLayers,
  };
}
