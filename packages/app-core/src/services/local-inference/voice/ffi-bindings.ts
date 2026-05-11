/**
 * Node/Bun FFI binding to `libelizainference.{dylib,so,dll}`.
 *
 * The fused omnivoice + llama.cpp build (see
 * `packages/app-core/scripts/omnivoice-fuse/`) produces ONE shared
 * library that exports both `llama_*` and `omnivoice_*` symbols plus
 * the C ABI declared in `scripts/omnivoice-fuse/ffi.h`. This module is
 * the JS-side proxy for that ABI — it loads the library, binds every
 * `eliza_inference_*` symbol declared in `ffi.h`, and exposes a typed
 * handle (`ElizaInferenceFfi`) the voice lifecycle calls into.
 *
 * Runtime: production runs under Bun (Electrobun shell, Capacitor
 * bridge), so the loader uses `bun:ffi`. Tests that need to actually
 * load a `.dylib` against a stub library spawn a `bun` subprocess —
 * see `ffi-bindings.test.ts`. Calling this loader from a non-Bun
 * runtime (e.g. plain Node) throws `VoiceLifecycleError({code:
 * "missing-ffi"})` with a diagnostic explaining why.
 *
 * No defensive try/catch on the success path. Any dlopen failure,
 * symbol-resolution failure, or ABI mismatch is a structured throw
 * (AGENTS.md §3 + §9). The caller — `voice/lifecycle.ts` and
 * `voice/engine-bridge.ts` — surfaces it as a `VoiceLifecycleError` to
 * the UI.
 */

import { VoiceLifecycleError } from "./lifecycle";

/**
 * ABI version the JS binding was authored against. Must match the value
 * `eliza_inference_abi_version()` returns at runtime — a mismatch is a
 * hard error (AGENTS.md §3, §9: no silent compatibility shims).
 *
 * Bump in lockstep with `ELIZA_INFERENCE_ABI_VERSION` in
 * `scripts/omnivoice-fuse/ffi.h` whenever the C surface changes shape.
 */
export const ELIZA_INFERENCE_ABI_VERSION = 3 as const;

/** Status codes mirrored from `ffi.h`. Negative = failure. */
export const ELIZA_OK = 0;
export const ELIZA_ERR_NOT_IMPLEMENTED = -1;
export const ELIZA_ERR_INVALID_ARG = -2;
export const ELIZA_ERR_BUNDLE_INVALID = -3;
export const ELIZA_ERR_FFI_FAULT = -4;
export const ELIZA_ERR_OOM = -5;
export const ELIZA_ERR_ABI_MISMATCH = -6;
export const ELIZA_ERR_CANCELLED = -7;

/**
 * Region names the lifecycle hands to `mmap_acquire` / `mmap_evict`.
 * Mirrors the set the C stub validates in `ffi-stub.c::valid_region`.
 */
export type ElizaInferenceRegion = "tts" | "asr" | "text" | "dflash" | "vad";

/**
 * Opaque pointer to the C-side `EliInferenceContext`. Numeric on Bun
 * (FFI returns the raw pointer as `bigint`); never inspected on the JS
 * side beyond passing it back through the binding.
 */
export type ElizaInferenceContextHandle = bigint;

/** Opaque pointer to a native Silero VAD session. */
export type NativeVadHandle = bigint;

/**
 * One streaming-TTS chunk delivered to the `onChunk` callback passed to
 * `ttsSynthesizeStream`. `pcm` is a *view* over the library's buffer —
 * valid only for the duration of the callback; copy it before
 * returning. `isFinal` marks the zero-length tail chunk that closes the
 * utterance. The callback returning `true` requests cancellation at the
 * next kernel boundary.
 */
export interface TtsStreamChunk {
  pcm: Float32Array;
  isFinal: boolean;
}

/**
 * A native DFlash speculative-step event from
 * `eliza_inference_set_verifier_callback`. Token-index domain is the
 * generated-output stream (token 0 = first generated token), matching
 * `RejectedTokenRange`. `rejectedFrom`/`rejectedTo` are -1 when nothing
 * was rejected this step.
 */
export interface NativeVerifierEvent {
  acceptedTokenIds: number[];
  rejectedFrom: number;
  rejectedTo: number;
  correctedTokenIds: number[];
}

/**
 * Typed handle returned by `loadElizaInferenceFfi`. Each method maps
 * 1:1 to a symbol declared in `ffi.h`. Methods that allocate a context
 * return the opaque pointer; methods that consume one take it as the
 * first argument. Failures throw `VoiceLifecycleError` with the
 * structured code derived from the C return value.
 */
export interface ElizaInferenceFfi {
  /** Library path the binding was loaded from (for diagnostics). */
  readonly libraryPath: string;
  /** ABI version reported by the loaded library. */
  readonly libraryAbiVersion: string;
  /** Create a fresh context anchored at `bundleDir`. */
  create(bundleDir: string): ElizaInferenceContextHandle;
  /** Destroy a previously-created context. Idempotent on already-freed handles. */
  destroy(ctx: ElizaInferenceContextHandle): void;
  /** Map / re-page weights for a region. */
  mmapAcquire(
    ctx: ElizaInferenceContextHandle,
    region: ElizaInferenceRegion,
  ): void;
  /**
   * Release or evict a voice-only region after the lifecycle leaves
   * voice-on. Implementations may madvise mapped pages or unload the
   * ASR/TTS runtime state entirely; callers must treat the region as
   * unavailable until the next `mmapAcquire`.
   */
  mmapEvict(
    ctx: ElizaInferenceContextHandle,
    region: ElizaInferenceRegion,
  ): void;
  /**
   * Synchronous TTS forward. Caller provides the output buffer; library
   * fills up to its capacity and returns the number of samples written.
   */
  ttsSynthesize(args: {
    ctx: ElizaInferenceContextHandle;
    text: string;
    speakerPresetId: string | null;
    out: Float32Array;
  }): number;
  /**
   * Synchronous ASR forward. Returns the decoded transcript as a UTF-8
   * string (allocated by the JS side, sized to fit the library's max
   * write).
   */
  asrTranscribe(args: {
    ctx: ElizaInferenceContextHandle;
    pcm: Float32Array;
    sampleRateHz: number;
    maxTextBytes?: number;
  }): string;

  /* ---- Streaming TTS + verifier callback (ABI v2) --------------- */

  /**
   * True when this build implements streaming TTS (false for the stub /
   * a TTS-disabled build). Callers pick the streaming path vs the batch
   * `ttsSynthesize` off this flag — no probe-and-catch.
   */
  ttsStreamSupported(): boolean;
  /**
   * Chunked synthesis. `onChunk` is invoked for each decoded PCM segment
   * as it arrives, then once more with `isFinal: true` (zero-length
   * tail). Returning `true` from `onChunk` requests cancellation; the
   * call then resolves with `cancelled: true` after the final-chunk
   * callback. Any negative library return is a thrown `VoiceLifecycleError`.
   */
  ttsSynthesizeStream(args: {
    ctx: ElizaInferenceContextHandle;
    text: string;
    speakerPresetId: string | null;
    onChunk: (chunk: TtsStreamChunk) => boolean | undefined;
  }): { cancelled: boolean };
  /**
   * Hard-cancel any in-flight TTS forward pass on `ctx` (started on
   * another thread by `ttsSynthesize` / `ttsSynthesizeStream`). The
   * in-flight call returns `ELIZA_ERR_CANCELLED` at the next kernel
   * boundary. Cancelling nothing is not an error.
   */
  cancelTts(ctx: ElizaInferenceContextHandle): void;
  /**
   * Register (or, with `cb: null`, clear) the native DFlash verifier
   * callback. The runtime fires `cb` for every speculative accept/reject
   * step from the in-process drafter↔target loop. The returned
   * `JSCallbackHandle` MUST be kept alive for as long as the callback is
   * registered and `.close()`d when it's cleared (or on dispose) — Bun's
   * `JSCallback` is GC'd otherwise and the native side dereferences a
   * dead pointer.
   */
  setVerifierCallback(
    ctx: ElizaInferenceContextHandle,
    cb: ((event: NativeVerifierEvent) => void) | null,
  ): { close(): void };

  /* ---- Native VAD (ABI v3) -------------------------------------- */

  /** True when this build exports and enables the native Silero VAD backend. */
  vadSupported(): boolean;
  /** Open a native VAD session. The ABI-compatible sample rate is 16 kHz. */
  vadOpen(args: {
    ctx: ElizaInferenceContextHandle;
    sampleRateHz: number;
  }): NativeVadHandle;
  /** Process one 512-sample fp32 mono window and return P(speech). */
  vadProcess(args: { vad: NativeVadHandle; pcm: Float32Array }): number;
  /** Clear native VAD recurrent state at utterance boundaries. */
  vadReset(vad: NativeVadHandle): void;
  /** Close + free a native VAD session. Idempotent on already-closed handles. */
  vadClose(vad: NativeVadHandle): void;

  /* ---- Streaming ASR (ABI v2) ----------------------------------- */

  /**
   * True when this build has a working streaming ASR decoder (false for
   * the stub / an ASR-disabled build). Callers pick the streaming path
   * vs the whisper.cpp interim adapter off this flag — they do not have
   * to open a session and catch `ELIZA_ERR_NOT_IMPLEMENTED`.
   */
  asrStreamSupported(): boolean;
  /** Open a streaming ASR session. The handle is closed via `asrStreamClose`. */
  asrStreamOpen(args: {
    ctx: ElizaInferenceContextHandle;
    sampleRateHz: number;
  }): bigint;
  /** Feed one PCM frame at the session's sample rate. */
  asrStreamFeed(args: { stream: bigint; pcm: Float32Array }): void;
  /** Read the current running partial transcript (and token ids when available). */
  asrStreamPartial(args: {
    stream: bigint;
    maxTextBytes?: number;
    maxTokens?: number;
  }): { partial: string; tokens?: number[] };
  /** Force-finalize: drain buffered audio, run a final decode, return the final transcript. */
  asrStreamFinish(args: {
    stream: bigint;
    maxTextBytes?: number;
    maxTokens?: number;
  }): { partial: string; tokens?: number[] };
  /** Close + free a streaming ASR session. Idempotent on already-closed handles. */
  asrStreamClose(stream: bigint): void;

  /** Best-effort dispose for the binding itself (closes the dlopen handle). */
  close(): void;
}

/* ---------------------------------------------------------------- */
/* Loader                                                           */
/* ---------------------------------------------------------------- */

/** Runtime detector: returns true when running under Bun. */
function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/**
 * Load `libelizainference` at `dylibPath` and bind every symbol
 * declared in `ffi.h`. The returned handle's methods delegate directly
 * to the library; they throw `VoiceLifecycleError` on any negative
 * return value or runtime fault.
 *
 * Throws synchronously (no Promise) when:
 *   - the JS runtime is not Bun (no FFI primitive available),
 *   - `dlopen` cannot find or open the library,
 *   - the library's reported ABI version does not match
 *     `ELIZA_INFERENCE_ABI_VERSION`.
 */
export function loadElizaInferenceFfi(dylibPath: string): ElizaInferenceFfi {
  if (!isBunRuntime()) {
    throw new VoiceLifecycleError(
      "kernel-missing",
      `[ffi-bindings] Cannot load libelizainference: current runtime is not Bun. ` +
        `The fused omnivoice FFI uses bun:ffi (production runs under Bun via Electrobun + Capacitor). ` +
        `process.versions=${JSON.stringify(process.versions)}`,
    );
  }
  if (!dylibPath || dylibPath.length === 0) {
    throw new VoiceLifecycleError(
      "kernel-missing",
      "[ffi-bindings] loadElizaInferenceFfi: dylibPath is required",
    );
  }
  return bindWithBunFfi(dylibPath);
}

/* ---------------------------------------------------------------- */
/* Bun:ffi binding                                                  */
/* ---------------------------------------------------------------- */

interface BunFfiSymbols {
  eliza_inference_abi_version: () => unknown;
  eliza_inference_create: (bundleDir: unknown, outErr: unknown) => unknown;
  eliza_inference_destroy: (ctx: bigint) => void;
  eliza_inference_mmap_acquire: (
    ctx: bigint,
    region: unknown,
    outErr: unknown,
  ) => number;
  eliza_inference_mmap_evict: (
    ctx: bigint,
    region: unknown,
    outErr: unknown,
  ) => number;
  eliza_inference_tts_synthesize: (
    ctx: bigint,
    text: unknown,
    textLen: bigint | number,
    speaker: unknown,
    outPcm: unknown,
    maxSamples: bigint | number,
    outErr: unknown,
  ) => number;
  eliza_inference_asr_transcribe: (
    ctx: bigint,
    pcm: unknown,
    nSamples: bigint | number,
    sampleRateHz: number,
    outText: unknown,
    maxTextBytes: bigint | number,
    outErr: unknown,
  ) => number;
  eliza_inference_tts_stream_supported: () => number;
  eliza_inference_tts_synthesize_stream: (
    ctx: bigint,
    text: unknown,
    textLen: bigint | number,
    speaker: unknown,
    onChunk: unknown,
    userData: bigint | number,
    outErr: unknown,
  ) => number;
  eliza_inference_cancel_tts: (ctx: bigint, outErr: unknown) => number;
  eliza_inference_set_verifier_callback: (
    ctx: bigint,
    cb: unknown,
    userData: bigint | number,
    outErr: unknown,
  ) => number;
  eliza_inference_vad_supported?: () => number;
  eliza_inference_vad_open?: (
    ctx: bigint,
    sampleRateHz: number,
    outErr: unknown,
  ) => unknown;
  eliza_inference_vad_process?: (
    vad: bigint,
    pcm: unknown,
    nSamples: bigint | number,
    outProbability: unknown,
    outErr: unknown,
  ) => number;
  eliza_inference_vad_reset?: (vad: bigint, outErr: unknown) => number;
  eliza_inference_vad_close?: (vad: bigint) => void;
  eliza_inference_asr_stream_supported: () => number;
  eliza_inference_asr_stream_open: (
    ctx: bigint,
    sampleRateHz: number,
    outErr: unknown,
  ) => unknown;
  eliza_inference_asr_stream_feed: (
    stream: bigint,
    pcm: unknown,
    nSamples: bigint | number,
    outErr: unknown,
  ) => number;
  eliza_inference_asr_stream_partial: (
    stream: bigint,
    outText: unknown,
    maxTextBytes: bigint | number,
    outTokens: unknown,
    ioNTokens: unknown,
    outErr: unknown,
  ) => number;
  eliza_inference_asr_stream_finish: (
    stream: bigint,
    outText: unknown,
    maxTextBytes: bigint | number,
    outTokens: unknown,
    ioNTokens: unknown,
    outErr: unknown,
  ) => number;
  eliza_inference_asr_stream_close: (stream: bigint) => void;
  eliza_inference_free_string: (str: bigint | number) => void;
}

interface BunFfiLib {
  symbols: BunFfiSymbols;
  close(): void;
}

interface BunFfiJSCallback {
  readonly ptr: bigint | number;
  close(): void;
}

interface BunFfiModule {
  dlopen(path: string, defs: Record<string, unknown>): BunFfiLib;
  FFIType: Record<string, number>;
  ptr(value: ArrayBufferView): unknown;
  CString: new (ptr: unknown) => { toString(): string };
  read: {
    ptr(buf: unknown, offset?: number): bigint;
    i32(buf: unknown, offset?: number): number;
    u64(buf: unknown, offset?: number): bigint;
  };
  toArrayBuffer(
    ptr: bigint | number,
    byteOffset?: number,
    byteLength?: number,
  ): ArrayBuffer;
  JSCallback: new (
    fn: (...args: never[]) => unknown,
    def: { args: number[]; returns: number },
  ) => BunFfiJSCallback;
}

/**
 * Resolve `bun:ffi` synchronously via the Bun-injected `require`.
 * Bun exposes a CJS `require` even from ESM modules, and `bun:ffi` is
 * a built-in importable that way. Doing this dynamically (rather than a
 * static `import "bun:ffi"`) keeps the module loadable under plain Node
 * for the parts of the test suite that don't need the FFI.
 */
function loadBunFfiModule(): BunFfiModule {
  const req: ((id: string) => unknown) | undefined = (
    globalThis as { Bun?: { __require?: (id: string) => unknown } }
  ).Bun?.__require;
  if (typeof req === "function") {
    return req("bun:ffi") as BunFfiModule;
  }
  // Fallback to `module.createRequire` on the current file when running
  // under Bun via an ESM entry without `Bun.__require`. This is rare —
  // current Bun exposes `Bun.__require` — but we keep the path explicit
  // so the failure mode is `MODULE_NOT_FOUND` (a real error), not a
  // silent fall-through.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("node:module") as {
    createRequire: (filename: string) => (id: string) => unknown;
  };
  const r = mod.createRequire(import.meta.url);
  return r("bun:ffi") as BunFfiModule;
}

function bindWithBunFfi(dylibPath: string): ElizaInferenceFfi {
  let ffi: BunFfiModule;
  try {
    ffi = loadBunFfiModule();
  } catch (err) {
    throw new VoiceLifecycleError(
      "kernel-missing",
      `[ffi-bindings] Cannot load bun:ffi while opening ${dylibPath}: ${formatFfiError(err)}`,
    );
  }
  const T = ffi.FFIType;

  // All `char *` arguments are typed as T.ptr — Bun's `T.cstring` is a
  // RETURN-only type for "library hands back a NUL-terminated string".
  // For inputs we encode UTF-8 to a NUL-terminated Buffer on the JS
  // side and pass `ffi.ptr(buffer)`.
  let lib: BunFfiLib;
  let nativeVadSymbolsAvailable = true;
  const nativeVadDefs = {
    // Native Silero VAD (ABI v3). These are additive; some transitional
    // builds may report ABI v3 before carrying the VAD symbols, so bind
    // them opportunistically and advertise unsupported if absent.
    eliza_inference_vad_supported: { args: [], returns: T.i32 },
    eliza_inference_vad_open: {
      args: [T.ptr, T.i32, T.ptr],
      returns: T.ptr,
    },
    eliza_inference_vad_process: {
      args: [T.usize, T.ptr, T.usize, T.ptr, T.ptr],
      returns: T.i32,
    },
    eliza_inference_vad_reset: { args: [T.usize, T.ptr], returns: T.i32 },
    eliza_inference_vad_close: { args: [T.usize], returns: T.void },
  };
  const coreDefs = {
    eliza_inference_abi_version: { args: [], returns: T.cstring },
    eliza_inference_create: {
      args: [T.ptr, T.ptr],
      returns: T.ptr,
    },
    eliza_inference_destroy: { args: [T.ptr], returns: T.void },
    eliza_inference_mmap_acquire: {
      args: [T.ptr, T.ptr, T.ptr],
      returns: T.i32,
    },
    eliza_inference_mmap_evict: {
      args: [T.ptr, T.ptr, T.ptr],
      returns: T.i32,
    },
    eliza_inference_tts_synthesize: {
      args: [T.ptr, T.ptr, T.usize, T.ptr, T.ptr, T.usize, T.ptr],
      returns: T.i32,
    },
    eliza_inference_asr_transcribe: {
      args: [T.ptr, T.ptr, T.usize, T.i32, T.ptr, T.usize, T.ptr],
      returns: T.i32,
    },
    // Streaming TTS + native verifier callback (ABI v2). The
    // function-pointer args are passed as raw pointer values
    // (`JSCallback.ptr`, or 0n to clear) so this binding owns the
    // JSCallback lifetime explicitly — see `ttsSynthesizeStream` /
    // `setVerifierCallback` below.
    eliza_inference_tts_stream_supported: { args: [], returns: T.i32 },
    eliza_inference_tts_synthesize_stream: {
      // ctx, text, text_len, speaker, on_chunk (fn ptr), user_data, out_error
      args: [T.ptr, T.ptr, T.usize, T.ptr, T.usize, T.usize, T.ptr],
      returns: T.i32,
    },
    eliza_inference_cancel_tts: { args: [T.ptr, T.ptr], returns: T.i32 },
    eliza_inference_set_verifier_callback: {
      // ctx, cb (fn ptr — 0 to clear), user_data, out_error
      args: [T.ptr, T.usize, T.usize, T.ptr],
      returns: T.i32,
    },
    // Streaming ASR (ABI v2).
    eliza_inference_asr_stream_supported: { args: [], returns: T.i32 },
    eliza_inference_asr_stream_open: {
      args: [T.ptr, T.i32, T.ptr],
      returns: T.ptr,
    },
    eliza_inference_asr_stream_feed: {
      // stream handle is a raw C pointer → pass as usize.
      args: [T.usize, T.ptr, T.usize, T.ptr],
      returns: T.i32,
    },
    eliza_inference_asr_stream_partial: {
      args: [T.usize, T.ptr, T.usize, T.ptr, T.ptr, T.ptr],
      returns: T.i32,
    },
    eliza_inference_asr_stream_finish: {
      args: [T.usize, T.ptr, T.usize, T.ptr, T.ptr, T.ptr],
      returns: T.i32,
    },
    eliza_inference_asr_stream_close: { args: [T.usize], returns: T.void },
    // Bun 1.3.x accepts raw pointer values passed back into C as
    // `usize`, while `ptr` is for JS-owned ArrayBuffer pointers.
    eliza_inference_free_string: { args: [T.usize], returns: T.void },
  };
  try {
    lib = ffi.dlopen(dylibPath, {
      ...coreDefs,
      ...nativeVadDefs,
    });
  } catch (err) {
    try {
      lib = ffi.dlopen(dylibPath, coreDefs);
      nativeVadSymbolsAvailable = false;
    } catch {
      throw new VoiceLifecycleError(
        "kernel-missing",
        `[ffi-bindings] Failed to open libelizainference at ${dylibPath}: ${formatFfiError(err)}`,
      );
    }
  }

  // ABI version check — refuse to run if the loaded library is not v3.
  const reported = readCString(lib.symbols.eliza_inference_abi_version(), ffi);
  if (reported !== String(ELIZA_INFERENCE_ABI_VERSION)) {
    lib.close();
    throw new VoiceLifecycleError(
      "kernel-missing",
      `[ffi-bindings] ABI mismatch: binding expected v${ELIZA_INFERENCE_ABI_VERSION}, ` +
        `library at ${dylibPath} reports v${reported}. The fused build was produced ` +
        `against a different ffi.h — rebuild against the current header.`,
    );
  }

  /**
   * Read `*outErrPtr` (a `char**` that the library populated with a
   * heap-allocated NUL-terminated string), free the underlying buffer
   * via `eliza_inference_free_string`, and return the JS string. When
   * the library left `*outErrPtr` as NULL, returns null.
   */
  function takeError(outErrPtrBuf: BigUint64Array): string | null {
    const ptrValue = outErrPtrBuf[0];
    if (ptrValue === undefined || ptrValue === 0n) return null;
    const ptrNumber = Number(ptrValue);
    if (!Number.isSafeInteger(ptrNumber)) {
      throw new VoiceLifecycleError(
        "kernel-missing",
        `[ffi-bindings] C diagnostic pointer ${ptrValue.toString()} exceeds JS safe integer range`,
      );
    }
    const cstr = new ffi.CString(ptrNumber);
    const message = cstr.toString();
    lib.symbols.eliza_inference_free_string(ptrValue);
    return message;
  }

  function makeOutErr(): { buf: BigUint64Array; ptr: unknown } {
    const buf = new BigUint64Array(1);
    return { buf, ptr: ffi.ptr(buf) };
  }

  /**
   * Encode a JS string to a NUL-terminated UTF-8 buffer and return a
   * `T.ptr`-compatible pointer suitable for `const char *` arguments.
   * Returns null when the input is null — the C ABI accepts NULL for
   * optional arguments like `speaker_preset_id`.
   */
  function cstr(value: string | null): {
    ptr: unknown;
    bytes: number;
    buffer: Buffer | null;
  } {
    if (value === null) return { ptr: null, bytes: 0, buffer: null };
    const bytes = Buffer.from(value, "utf8");
    const buf = Buffer.alloc(bytes.byteLength + 1);
    bytes.copy(buf);
    return { ptr: ffi.ptr(buf), bytes: bytes.byteLength, buffer: buf };
  }

  function failureCode(rc: number): VoiceLifecycleError["code"] {
    if (rc === ELIZA_ERR_OOM) return "ram-pressure";
    if (rc === ELIZA_ERR_FFI_FAULT) return "mmap-fail";
    if (rc === ELIZA_ERR_NOT_IMPLEMENTED) return "kernel-missing";
    if (rc === ELIZA_ERR_ABI_MISMATCH) return "kernel-missing";
    if (rc === ELIZA_ERR_BUNDLE_INVALID) return "kernel-missing";
    return "kernel-missing";
  }

  function isNullPointer(value: unknown): boolean {
    return value === null || value === undefined || value === 0n || value === 0;
  }

  return {
    libraryPath: dylibPath,
    libraryAbiVersion: reported,

    create(bundleDir: string): ElizaInferenceContextHandle {
      const err = makeOutErr();
      const bundleArg = cstr(bundleDir);
      const handle = lib.symbols.eliza_inference_create(bundleArg.ptr, err.ptr);
      if (isNullPointer(handle)) {
        const message =
          takeError(err.buf) ??
          "[ffi-bindings] eliza_inference_create returned NULL with no diagnostic";
        throw new VoiceLifecycleError("kernel-missing", message);
      }
      return handle as ElizaInferenceContextHandle;
    },

    destroy(ctx: ElizaInferenceContextHandle): void {
      lib.symbols.eliza_inference_destroy(ctx);
    },

    mmapAcquire(ctx, region) {
      const err = makeOutErr();
      const regionArg = cstr(region);
      const rc = lib.symbols.eliza_inference_mmap_acquire(
        ctx,
        regionArg.ptr,
        err.ptr,
      );
      if (rc !== ELIZA_OK) {
        const message =
          takeError(err.buf) ??
          `[ffi-bindings] eliza_inference_mmap_acquire(${region}) rc=${rc}`;
        throw new VoiceLifecycleError(failureCode(rc), message);
      }
    },

    mmapEvict(ctx, region) {
      const err = makeOutErr();
      const regionArg = cstr(region);
      const rc = lib.symbols.eliza_inference_mmap_evict(
        ctx,
        regionArg.ptr,
        err.ptr,
      );
      if (rc !== ELIZA_OK) {
        const message =
          takeError(err.buf) ??
          `[ffi-bindings] eliza_inference_mmap_evict(${region}) rc=${rc}`;
        throw new VoiceLifecycleError(failureCode(rc), message);
      }
    },

    ttsSynthesize({ ctx, text, speakerPresetId, out }) {
      const err = makeOutErr();
      const textArg = cstr(text);
      const speakerArg = cstr(speakerPresetId);
      const rc = lib.symbols.eliza_inference_tts_synthesize(
        ctx,
        textArg.ptr,
        BigInt(textArg.bytes),
        speakerArg.ptr,
        ffi.ptr(out),
        BigInt(out.length),
        err.ptr,
      );
      if (rc < 0) {
        const message =
          takeError(err.buf) ??
          `[ffi-bindings] eliza_inference_tts_synthesize rc=${rc}`;
        throw new VoiceLifecycleError(failureCode(rc), message);
      }
      return rc;
    },

    asrTranscribe({ ctx, pcm, sampleRateHz, maxTextBytes }) {
      const err = makeOutErr();
      const cap = maxTextBytes ?? 4096;
      const outText = new Uint8Array(cap);
      const rc = lib.symbols.eliza_inference_asr_transcribe(
        ctx,
        ffi.ptr(pcm),
        BigInt(pcm.length),
        sampleRateHz,
        ffi.ptr(outText),
        BigInt(cap),
        err.ptr,
      );
      if (rc < 0) {
        const message =
          takeError(err.buf) ??
          `[ffi-bindings] eliza_inference_asr_transcribe rc=${rc}`;
        throw new VoiceLifecycleError(failureCode(rc), message);
      }
      const nul = outText.indexOf(0, 0);
      const len = nul >= 0 ? nul : rc;
      return Buffer.from(outText.buffer, outText.byteOffset, len).toString(
        "utf8",
      );
    },

    /* ---- Streaming TTS + verifier callback (ABI v2) ------------ */

    ttsStreamSupported(): boolean {
      return lib.symbols.eliza_inference_tts_stream_supported() === 1;
    },

    ttsSynthesizeStream({ ctx, text, speakerPresetId, onChunk }) {
      const err = makeOutErr();
      const textArg = cstr(text);
      const speakerArg = cstr(speakerPresetId);
      // (pcm: ptr, n_samples: usize, is_final: i32, user_data: ptr) -> i32
      const cb = new ffi.JSCallback(
        ((pcmPtr: bigint, nSamples: bigint, isFinal: number) => {
          const n = Number(nSamples);
          // Bun delivers the C pointer as a bigint; copy the floats out
          // before returning — the buffer is the library's, valid only
          // for this call.
          const pcm =
            n > 0 && pcmPtr !== 0n
              ? new Float32Array(ffi.toArrayBuffer(pcmPtr, 0, n * 4).slice(0))
              : new Float32Array(0);
          const requestCancel = onChunk({ pcm, isFinal: isFinal !== 0 });
          return requestCancel === true ? 1 : 0;
        }) as unknown as (...args: never[]) => unknown,
        {
          args: [T.ptr, T.usize, T.i32, T.ptr],
          returns: T.i32,
        },
      );
      try {
        const rc = lib.symbols.eliza_inference_tts_synthesize_stream(
          ctx,
          textArg.ptr,
          BigInt(textArg.bytes),
          speakerArg.ptr,
          BigInt(cb.ptr),
          0n,
          err.ptr,
        );
        if (rc === ELIZA_ERR_CANCELLED) return { cancelled: true };
        if (rc < 0) {
          const message =
            takeError(err.buf) ??
            `[ffi-bindings] eliza_inference_tts_synthesize_stream rc=${rc}`;
          throw new VoiceLifecycleError(failureCode(rc), message);
        }
        return { cancelled: false };
      } finally {
        cb.close();
      }
    },

    cancelTts(ctx) {
      const err = makeOutErr();
      const rc = lib.symbols.eliza_inference_cancel_tts(ctx, err.ptr);
      if (rc !== ELIZA_OK) {
        const message =
          takeError(err.buf) ??
          `[ffi-bindings] eliza_inference_cancel_tts rc=${rc}`;
        throw new VoiceLifecycleError(failureCode(rc), message);
      }
    },

    setVerifierCallback(ctx, cbFn) {
      const err = makeOutErr();
      if (cbFn === null) {
        const rc = lib.symbols.eliza_inference_set_verifier_callback(
          ctx,
          0n,
          0n,
          err.ptr,
        );
        if (rc !== ELIZA_OK) {
          const message =
            takeError(err.buf) ??
            `[ffi-bindings] eliza_inference_set_verifier_callback(clear) rc=${rc}`;
          throw new VoiceLifecycleError(failureCode(rc), message);
        }
        return { close: () => {} };
      }
      // (ev: ptr to EliVerifierEvent, user_data: ptr) -> void
      const cb = new ffi.JSCallback(
        ((evPtr: bigint) => {
          cbFn(readVerifierEvent(evPtr, ffi));
        }) as unknown as (...args: never[]) => unknown,
        { args: [T.ptr, T.ptr], returns: T.void },
      );
      const rc = lib.symbols.eliza_inference_set_verifier_callback(
        ctx,
        BigInt(cb.ptr),
        0n,
        err.ptr,
      );
      if (rc !== ELIZA_OK) {
        cb.close();
        const message =
          takeError(err.buf) ??
          `[ffi-bindings] eliza_inference_set_verifier_callback rc=${rc}`;
        throw new VoiceLifecycleError(failureCode(rc), message);
      }
      return {
        close: () => {
          // Clear the native registration FIRST, then free the
          // JSCallback — order matters so the native side never
          // dereferences a closed callback.
          const clearErr = makeOutErr();
          lib.symbols.eliza_inference_set_verifier_callback(
            ctx,
            0n,
            0n,
            clearErr.ptr,
          );
          takeError(clearErr.buf);
          cb.close();
        },
      };
    },

    /* ---- Native VAD (ABI v3) ----------------------------------- */

    vadSupported(): boolean {
      if (
        !nativeVadSymbolsAvailable ||
        typeof lib.symbols.eliza_inference_vad_supported !== "function"
      ) {
        return false;
      }
      return lib.symbols.eliza_inference_vad_supported() === 1;
    },

    vadOpen({ ctx, sampleRateHz }) {
      const open = lib.symbols.eliza_inference_vad_open;
      if (!nativeVadSymbolsAvailable || typeof open !== "function") {
        throw new VoiceLifecycleError(
          "kernel-missing",
          "[ffi-bindings] eliza_inference_vad_open is not exported by this libelizainference build",
        );
      }
      const err = makeOutErr();
      const handle = open(ctx, sampleRateHz, err.ptr);
      if (isNullPointer(handle)) {
        const message =
          takeError(err.buf) ??
          "[ffi-bindings] eliza_inference_vad_open returned NULL with no diagnostic";
        throw new VoiceLifecycleError("kernel-missing", message);
      }
      return handle as NativeVadHandle;
    },

    vadProcess({ vad, pcm }) {
      const process = lib.symbols.eliza_inference_vad_process;
      if (!nativeVadSymbolsAvailable || typeof process !== "function") {
        throw new VoiceLifecycleError(
          "kernel-missing",
          "[ffi-bindings] eliza_inference_vad_process is not exported by this libelizainference build",
        );
      }
      const err = makeOutErr();
      const outProbability = new Float32Array(1);
      const rc = process(
        vad,
        ffi.ptr(pcm),
        BigInt(pcm.length),
        ffi.ptr(outProbability),
        err.ptr,
      );
      if (rc !== ELIZA_OK) {
        const message =
          takeError(err.buf) ??
          `[ffi-bindings] eliza_inference_vad_process rc=${rc}`;
        throw new VoiceLifecycleError(failureCode(rc), message);
      }
      return outProbability[0] ?? 0;
    },

    vadReset(vad) {
      const reset = lib.symbols.eliza_inference_vad_reset;
      if (!nativeVadSymbolsAvailable || typeof reset !== "function") {
        throw new VoiceLifecycleError(
          "kernel-missing",
          "[ffi-bindings] eliza_inference_vad_reset is not exported by this libelizainference build",
        );
      }
      const err = makeOutErr();
      const rc = reset(vad, err.ptr);
      if (rc !== ELIZA_OK) {
        const message =
          takeError(err.buf) ??
          `[ffi-bindings] eliza_inference_vad_reset rc=${rc}`;
        throw new VoiceLifecycleError(failureCode(rc), message);
      }
    },

    vadClose(vad) {
      lib.symbols.eliza_inference_vad_close?.(vad);
    },

    /* ---- Streaming ASR (ABI v2) -------------------------------- */

    asrStreamSupported(): boolean {
      return lib.symbols.eliza_inference_asr_stream_supported() === 1;
    },

    asrStreamOpen({ ctx, sampleRateHz }) {
      const err = makeOutErr();
      const handle = lib.symbols.eliza_inference_asr_stream_open(
        ctx,
        sampleRateHz,
        err.ptr,
      );
      if (isNullPointer(handle)) {
        const message =
          takeError(err.buf) ??
          "[ffi-bindings] eliza_inference_asr_stream_open returned NULL with no diagnostic";
        throw new VoiceLifecycleError("kernel-missing", message);
      }
      return handle as bigint;
    },

    asrStreamFeed({ stream, pcm }) {
      const err = makeOutErr();
      const rc = lib.symbols.eliza_inference_asr_stream_feed(
        stream,
        ffi.ptr(pcm),
        BigInt(pcm.length),
        err.ptr,
      );
      if (rc < 0) {
        const message =
          takeError(err.buf) ??
          `[ffi-bindings] eliza_inference_asr_stream_feed rc=${rc}`;
        throw new VoiceLifecycleError(failureCode(rc), message);
      }
    },

    asrStreamPartial(args) {
      return readAsrStreamResult(
        "partial",
        lib.symbols.eliza_inference_asr_stream_partial,
        args,
      );
    },

    asrStreamFinish(args) {
      return readAsrStreamResult(
        "finish",
        lib.symbols.eliza_inference_asr_stream_finish,
        args,
      );
    },

    asrStreamClose(stream) {
      lib.symbols.eliza_inference_asr_stream_close(stream);
    },

    close(): void {
      lib.close();
    },
  };

  /**
   * Shared body for `asr_stream_partial` / `asr_stream_finish` — both
   * have the same 6-arg shape (`stream, out_text, max_text_bytes,
   * out_tokens, io_n_tokens, out_error`). Token ids are read only when
   * the caller asks for them (`maxTokens > 0`); otherwise the
   * out_tokens / io_n_tokens pointers are NULL.
   */
  function readAsrStreamResult(
    label: string,
    fn: (
      stream: bigint,
      outText: unknown,
      maxTextBytes: bigint | number,
      outTokens: unknown,
      ioNTokens: unknown,
      outErr: unknown,
    ) => number,
    args: { stream: bigint; maxTextBytes?: number; maxTokens?: number },
  ): { partial: string; tokens?: number[] } {
    const err = makeOutErr();
    const textCap = args.maxTextBytes ?? 4096;
    const outText = new Uint8Array(textCap);
    const wantTokens = (args.maxTokens ?? 0) > 0;
    const tokenCap = wantTokens ? (args.maxTokens as number) : 0;
    const outTokens = wantTokens ? new Int32Array(tokenCap) : null;
    const ioNTokens = wantTokens
      ? new BigUint64Array([BigInt(tokenCap)])
      : null;
    const rc = fn(
      args.stream,
      ffi.ptr(outText),
      BigInt(textCap),
      outTokens ? ffi.ptr(outTokens) : null,
      ioNTokens ? ffi.ptr(ioNTokens) : null,
      err.ptr,
    );
    if (rc < 0) {
      const message =
        takeError(err.buf) ??
        `[ffi-bindings] eliza_inference_asr_stream_${label} rc=${rc}`;
      throw new VoiceLifecycleError(failureCode(rc), message);
    }
    const nul = outText.indexOf(0, 0);
    const len = nul >= 0 ? nul : rc;
    const partial = Buffer.from(
      outText.buffer,
      outText.byteOffset,
      len,
    ).toString("utf8");
    if (wantTokens && outTokens && ioNTokens) {
      const n = Number(ioNTokens[0] ?? 0n);
      const tokens = Array.from(outTokens.subarray(0, Math.min(n, tokenCap)));
      return { partial, tokens };
    }
    return { partial };
  }
}

function formatFfiError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * Read an `EliVerifierEvent` (see `ffi.h`) from a C struct pointer.
 * Layout on 64-bit (8-byte aligned, default packing):
 *   off 0  : const int* accepted_token_ids   (8)
 *   off 8  : size_t      n_accepted           (8)
 *   off 16 : int         rejected_from        (4)
 *   off 20 : int         rejected_to          (4)
 *   off 24 : const int*  corrected_token_ids  (8)
 *   off 32 : size_t      n_corrected          (8)
 */
function readVerifierEvent(
  evPtr: bigint,
  ffi: BunFfiModule,
): NativeVerifierEvent {
  const acceptedPtr = ffi.read.ptr(evPtr, 0);
  const nAccepted = Number(ffi.read.u64(evPtr, 8));
  const rejectedFrom = ffi.read.i32(evPtr, 16);
  const rejectedTo = ffi.read.i32(evPtr, 20);
  const correctedPtr = ffi.read.ptr(evPtr, 24);
  const nCorrected = Number(ffi.read.u64(evPtr, 32));
  return {
    acceptedTokenIds: readInt32Array(acceptedPtr, nAccepted, ffi),
    rejectedFrom,
    rejectedTo,
    correctedTokenIds: readInt32Array(correctedPtr, nCorrected, ffi),
  };
}

function readInt32Array(
  ptr: bigint,
  count: number,
  ffi: BunFfiModule,
): number[] {
  if (ptr === 0n || count <= 0) return [];
  // Copy out — the array is the library's, valid only for the callback.
  const view = new Int32Array(ffi.toArrayBuffer(ptr, 0, count * 4).slice(0));
  return Array.from(view);
}

/**
 * Decode a `T.cstring` return value (Bun returns these as either a
 * lazy string-like object with `toString()` or a JS string depending
 * on version). Wrap so the caller never has to branch.
 */
function readCString(value: unknown, ffi: BunFfiModule): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && value !== null && "toString" in value) {
    return (value as { toString(): string }).toString();
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return new ffi.CString(value).toString();
  }
  return String(value);
}
