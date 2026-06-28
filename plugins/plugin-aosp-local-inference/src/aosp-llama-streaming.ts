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
 *   - `bun:ffi` is the only path to the native runtime on the AOSP agent
 *     process; the fused `libelizainference.so` is the sole text/voice
 *     native library and lives in the per-ABI asset dir on Android
 *     (`agent/{abi}/libelizainference.so`), built by
 *     `scripts/elizaos/compile-libelizainference.mjs` (the fused pipeline
 *     driven by `cmake-graft.mjs`).  Putting the binding here keeps all
 *     native on-device inference co-located.
 *   - It lets us register the same `FfiStreamingRunnerFactory` shape the
 *     dispatcher imports from app-core — so the existing dispatcher
 *     stitches mobile streaming through the same entry point the desktop
 *     runner uses.
 *
 * Important: this module does NOT load a model itself.  It binds the
 * streaming-LLM symbols on top of a `libelizainference` handle that was
 * opened by the shared voice-lifecycle FFI service.  When the streaming
 * symbols are missing (older fused build) the loader returns null and the
 * AOSP text path fails loud (local text inference unavailable) — there is
 * no libllama fallback.
 */

import { logger } from "@elizaos/core";

/* -------------------------------------------------------------------- */
/* JS-visible types — kept in sync with app-core's ffi-bindings.ts.     */
/* -------------------------------------------------------------------- */

/**
 * Opaque pointer to a streaming-LLM session.  Numeric on `bun:ffi`
 * (returned as `bigint`); never inspected on the JS side.
 */
// bun:ffi returns the `FFIType.ptr` stream handle as a number (it round-trips
// to a bigint via `toBig` for the `usize` arg slots).
export type AospLlmStreamHandle = number | bigint;

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
  mtpDrafterPath: string | null;
  disableThinking: boolean;
  /** KV-cache K quant type name (e.g. `qjl1_256`); null/absent = f16. */
  cacheTypeK?: string | null;
  /** KV-cache V quant type name (e.g. `q4_polar`); null/absent = f16. */
  cacheTypeV?: string | null;
  /** KV context size in tokens. ABI v9 appends this at offset 80; 0 = native default. */
  contextSize?: number | null;
}

/**
 * One streaming step surfaced to the runner.  `tokens` carries the
 * accepted-batch token ids (>= 1 — > 1 only under MTP speculative
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
/* Binding factory over a dlopen'd libelizainference symbol table.       */
/*                                                                       */
/* The bootstrap dlopens libelizainference.so (it already does so for    */
/* fused TTS/ASR) and passes the bound symbols + a few bun:ffi helpers   */
/* here; this module owns the JS↔C marshalling so the contract stays in  */
/* one place and is unit-testable against a fake symbol table.           */
/* -------------------------------------------------------------------- */

/**
 * The libelizainference C functions this binding drives. Names + arg/return
 * shapes mirror `eliza-inference-ffi.h` (ABI v9) and the desktop binding in
 * `@elizaos/plugin-local-inference`'s `voice/ffi-bindings.ts`. `ctx` is the
 * `EliInferenceContext*`; stream handles round-trip as raw pointers (bigint).
 */
/**
 * bun:ffi marshals `FFIType.ptr` args/returns as a JS `number` and `usize`/`u64`
 * as a `bigint`. The binding hands `T.ptr` args a number (`helpers.ptr` /
 * `Number(ctx)`) and `usize` args a bigint (`toBig` / `BigInt`), so every word
 * here is `number | bigint`.
 */
type FfiWord = number | bigint;

export interface AospFusedLlmSymbols {
  eliza_inference_llm_stream_supported?: () => number;
  eliza_inference_llm_mtp_supported?: () => number;
  eliza_inference_llm_kv_quant_supported?: () => number;
  eliza_inference_llm_stream_open: (
    ctx: FfiWord,
    cfg: FfiWord,
    outError: FfiWord,
  ) => FfiWord;
  eliza_inference_llm_stream_prefill: (
    stream: FfiWord,
    tokens: FfiWord,
    nTokens: FfiWord,
    outError: FfiWord,
  ) => number;
  eliza_inference_llm_stream_next: (
    stream: FfiWord,
    tokensOut: FfiWord,
    tokensCap: FfiWord,
    numTokensOut: FfiWord,
    textOut: FfiWord,
    textCap: FfiWord,
    drafterDrafted: FfiWord,
    drafterAccepted: FfiWord,
    outError: FfiWord,
  ) => number;
  eliza_inference_llm_stream_cancel: (stream: FfiWord) => number;
  eliza_inference_llm_stream_save_slot?: (
    stream: FfiWord,
    filename: FfiWord,
    outError: FfiWord,
  ) => number;
  eliza_inference_llm_stream_restore_slot?: (
    stream: FfiWord,
    filename: FfiWord,
    outError: FfiWord,
  ) => number;
  eliza_inference_llm_stream_close: (stream: FfiWord) => void;
}

/**
 * bun:ffi helpers the binding needs, supplied by the caller so this module
 * never imports `bun:ffi` directly (keeps it bundler-safe + testable).
 */
export interface AospFfiPointerHelpers {
  /** Pointer (as bigint) to a JS-owned ArrayBufferView. */
  // bun:ffi `FFIType.ptr` args take a NUMBER Pointer (not a bigint). Callers
  // that need the address as a 64-bit value for a struct field BigInt()-wrap it.
  ptr(view: ArrayBufferView): number;
  /** Read the diagnostic C string out of an `out_error` slot and free it. */
  takeError(outErrorBuffer: Buffer): string | null;
  /** NUL-terminate a UTF-8 string into a Buffer (kept alive by the caller). */
  cString(value: string): Buffer;
}

const LLM_STREAM_CONFIG_SIZE = 88;

/**
 * Marshal an `AospLlmStreamConfig` into the 88-byte `eliza_llm_stream_config_t`
 * struct (ABI v9, 8-byte aligned). Returns the struct buffer plus the
 * string-arg buffers it points into — the caller MUST keep those alive until
 * after `llm_stream_open` returns (GC of a referenced Buffer would dangle the
 * pointer). Mirrors the desktop binding's `llmStreamOpen` marshaller exactly.
 */
export function marshalAospLlmStreamConfig(
  config: AospLlmStreamConfig,
  helpers: Pick<AospFfiPointerHelpers, "ptr" | "cString">,
  gpuLayers: number | undefined,
): { struct: Buffer; keepAlive: Buffer[] } {
  const buf = Buffer.alloc(LLM_STREAM_CONFIG_SIZE);
  buf.writeInt32LE(config.maxTokens, 0);
  buf.writeFloatLE(config.temperature, 4);
  buf.writeFloatLE(config.topP, 8);
  buf.writeInt32LE(config.topK, 12);
  buf.writeFloatLE(config.repeatPenalty, 16);
  buf.writeInt32LE(config.slotId, 20);

  const keepAlive: Buffer[] = [];
  const ptrFor = (value: string | null): bigint => {
    if (!value || value.length === 0) return 0n;
    const b = helpers.cString(value);
    keepAlive.push(b);
    // The struct field is a 64-bit pointer slot (writeBigUInt64LE) — widen the
    // number address back to bigint for the write.
    return BigInt(helpers.ptr(b));
  };

  buf.writeBigUInt64LE(ptrFor(config.promptCacheKey), 24);
  buf.writeInt32LE(config.draftMin, 32);
  buf.writeInt32LE(config.draftMax, 36);
  buf.writeBigUInt64LE(ptrFor(config.mtpDrafterPath), 40);
  // gbnf_grammar (off 48): the streaming generate path does not pass a
  // grammar through this struct today.
  buf.writeBigUInt64LE(0n, 48);
  buf.writeInt32LE(config.disableThinking ? 1 : 0, 56);
  // -1 = runtime default (all layers); 0 = CPU. `undefined` -> -1.
  buf.writeInt32LE(gpuLayers === undefined ? -1 : gpuLayers, 60);
  buf.writeBigUInt64LE(ptrFor(config.cacheTypeK ?? null), 64);
  buf.writeBigUInt64LE(ptrFor(config.cacheTypeV ?? null), 72);
  // off 80 = context_size (ABI v9). 0 lets the native side keep its default.
  buf.writeInt32LE(config.contextSize ?? 0, 80);
  return { struct: buf, keepAlive };
}

/**
 * Optional KV-cache type names threaded into the streaming config. Carried
 * separately from `AospLlmStreamConfig` because the desktop config shape does
 * not include them on the wire type — the binding adds them when marshalling.
 */
export interface AospFusedKvCacheTypes {
  cacheTypeK?: string | null;
  cacheTypeV?: string | null;
}

/**
 * The fused binding plus the ABI-v9 capability probes the text-path gate
 * reads. A v7/v8 library leaves the MTP / KV-quant probe symbols unbound, so
 * the probes return false and the gate refuses the fused text path (the AOSP
 * text path then fails loud — there is no libllama fallback).
 */
export interface AospFusedStreamingLlmBinding extends AospStreamingLlmBinding {
  llmMtpSupported(): boolean;
  llmKvQuantSupported(): boolean;
}

/** Build an `AospStreamingLlmBinding` over a dlopen'd libelizainference. */
export function createAospStreamingLlmBinding(deps: {
  ctx: AospInferenceContextHandle;
  symbols: AospFusedLlmSymbols;
  helpers: AospFfiPointerHelpers;
  /** Per-load GPU layer count threaded into every stream config. */
  gpuLayers?: number;
  /** Per-load KV-cache type names threaded into every stream config. */
  kvCacheTypes?: AospFusedKvCacheTypes;
}): AospFusedStreamingLlmBinding {
  const { symbols, helpers, gpuLayers, kvCacheTypes } = deps;

  const isNull = (p: unknown): boolean =>
    p === null || p === undefined || p === 0 || p === 0n;
  const toBig = (p: AospLlmStreamHandle): bigint =>
    typeof p === "bigint" ? p : BigInt(p);

  return {
    llmStreamSupported(): boolean {
      const probe = symbols.eliza_inference_llm_stream_supported;
      return (
        typeof symbols.eliza_inference_llm_stream_open === "function" &&
        (typeof probe !== "function" || probe() === 1)
      );
    },

    llmMtpSupported(): boolean {
      const probe = symbols.eliza_inference_llm_mtp_supported;
      return typeof probe === "function" && probe() === 1;
    },

    llmKvQuantSupported(): boolean {
      const probe = symbols.eliza_inference_llm_kv_quant_supported;
      return typeof probe === "function" && probe() === 1;
    },

    llmStreamOpen({ ctx, config }): AospLlmStreamHandle {
      const { struct, keepAlive } = marshalAospLlmStreamConfig(
        {
          ...config,
          cacheTypeK: kvCacheTypes?.cacheTypeK ?? config.cacheTypeK ?? null,
          cacheTypeV: kvCacheTypes?.cacheTypeV ?? config.cacheTypeV ?? null,
        },
        helpers,
        gpuLayers,
      );
      const err = Buffer.alloc(8);
      // ctx is the EliInferenceContext* — a `T.ptr` arg, so it must be a NUMBER
      // (not bigint). `toBig` is only for the `usize` stream handle below.
      const handle = symbols.eliza_inference_llm_stream_open(
        Number(ctx),
        helpers.ptr(struct),
        helpers.ptr(err),
      );
      // keepAlive referenced after the synchronous call so the GC can't free
      // the config string buffers mid-open.
      void keepAlive;
      if (isNull(handle)) {
        const message =
          helpers.takeError(err) ??
          "[aosp-llama-streaming] eliza_inference_llm_stream_open returned NULL";
        throw new Error(message);
      }
      return handle;
    },

    llmStreamPrefill({ stream, tokens }): void {
      const err = Buffer.alloc(8);
      const rc = symbols.eliza_inference_llm_stream_prefill(
        toBig(stream),
        helpers.ptr(tokens),
        BigInt(tokens.length),
        helpers.ptr(err),
      );
      if (rc !== 0) {
        throw new Error(
          helpers.takeError(err) ??
            `[aosp-llama-streaming] llm_stream_prefill rc=${rc}`,
        );
      }
    },

    llmStreamNext({
      stream,
      maxTokensPerStep,
      maxTextBytes,
    }): AospLlmStreamStep {
      const tokenCap = maxTokensPerStep ?? 32;
      const textCap = maxTextBytes ?? 1024;
      const tokensOut = new Int32Array(tokenCap);
      const numTokensOut = new BigUint64Array(1);
      const textOut = new Uint8Array(textCap);
      const drafterDrafted = new Int32Array(1);
      const drafterAccepted = new Int32Array(1);
      const err = Buffer.alloc(8);
      const rc = symbols.eliza_inference_llm_stream_next(
        toBig(stream),
        helpers.ptr(tokensOut),
        BigInt(tokenCap),
        helpers.ptr(numTokensOut),
        helpers.ptr(textOut),
        BigInt(textCap),
        helpers.ptr(drafterDrafted),
        helpers.ptr(drafterAccepted),
        helpers.ptr(err),
      );
      if (rc < 0) {
        throw new Error(
          helpers.takeError(err) ??
            `[aosp-llama-streaming] llm_stream_next rc=${rc}`,
        );
      }
      const n = Number(numTokensOut[0] ?? 0n);
      const tokens = Array.from(tokensOut.subarray(0, Math.min(n, tokenCap)));
      const nul = textOut.indexOf(0, 0);
      const len = nul >= 0 ? nul : textCap;
      const text = Buffer.from(
        textOut.buffer,
        textOut.byteOffset,
        len,
      ).toString("utf8");
      return {
        tokens,
        text,
        done: rc === 1,
        drafterDrafted: drafterDrafted[0] ?? 0,
        drafterAccepted: drafterAccepted[0] ?? 0,
      };
    },

    llmStreamCancel(stream): void {
      symbols.eliza_inference_llm_stream_cancel(toBig(stream));
    },

    llmStreamSaveSlot({ stream, filename }): void {
      const save = symbols.eliza_inference_llm_stream_save_slot;
      if (typeof save !== "function") {
        throw new Error(
          "[aosp-llama-streaming] eliza_inference_llm_stream_save_slot not exported",
        );
      }
      const err = Buffer.alloc(8);
      const fname = helpers.cString(filename);
      const rc = save(toBig(stream), helpers.ptr(fname), helpers.ptr(err));
      if (rc !== 0) {
        throw new Error(
          helpers.takeError(err) ??
            `[aosp-llama-streaming] llm_stream_save_slot rc=${rc}`,
        );
      }
    },

    llmStreamRestoreSlot({ stream, filename }): void {
      const restore = symbols.eliza_inference_llm_stream_restore_slot;
      if (typeof restore !== "function") {
        throw new Error(
          "[aosp-llama-streaming] eliza_inference_llm_stream_restore_slot not exported",
        );
      }
      const err = Buffer.alloc(8);
      const fname = helpers.cString(filename);
      const rc = restore(toBig(stream), helpers.ptr(fname), helpers.ptr(err));
      if (rc !== 0) {
        throw new Error(
          helpers.takeError(err) ??
            `[aosp-llama-streaming] llm_stream_restore_slot rc=${rc}`,
        );
      }
    },

    llmStreamClose(stream): void {
      symbols.eliza_inference_llm_stream_close(toBig(stream));
    },
  };
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
 *   - decide whether the MTP adapter should attempt speculative
 *     decoding (`mtpSupported === false` → run target-only),
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
  mtpSupported: boolean;
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
  // Mobile builds today don't carry the drafter weights mapped — MTP
  // requires both target + drafter resident.  Marking mtpSupported
  // off on mobile lets the runtime emit a single accept event per token
  // (no rejects) instead of routing through the verifier callback.
  // Desktop keeps its native verifier-callback drive.
  const mtpSupported = streamingLlm && platform === "other";
  // mmproj almost never fits on a phone alongside the chat model; let
  // the runtime opt the build in explicitly when it does.
  const mmprojSupported = platform === "other";
  return {
    streamingLlm,
    mtpSupported,
    omnivoiceStreaming,
    mmprojSupported,
  };
}

/**
 * Gate for routing AOSP text generation through the fused libelizainference
 * streaming path. Requires ALL THREE ABI-v9 probes:
 *   - `llmStreamSupported` — the streaming-LLM symbols are exported, and
 *   - `llmMtpSupported` && `llmKvQuantSupported` — the MTP + KV-quant
 *     capability probes report 1.
 *
 * A v7/v8 library (probes absent → false) is refused, so the AOSP text path
 * fails loud (local text inference unavailable) — there is no libllama
 * fallback. Mirrors the desktop fused gate in
 * `desktop-fused-ffi-backend-runtime.ts`.
 */
export function fusedAospTextSupported(
  binding: AospFusedStreamingLlmBinding | null,
): boolean {
  if (!binding) return false;
  return (
    binding.llmStreamSupported() &&
    binding.llmMtpSupported() &&
    binding.llmKvQuantSupported()
  );
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
      `mtpSupported=${caps.mtpSupported} ` +
      `omnivoiceStreaming=${caps.omnivoiceStreaming} ` +
      `mmprojSupported=${caps.mmprojSupported}`,
  );
}
