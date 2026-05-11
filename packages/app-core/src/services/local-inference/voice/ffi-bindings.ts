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
export const ELIZA_INFERENCE_ABI_VERSION = 2 as const;

/** Status codes mirrored from `ffi.h`. Negative = failure. */
export const ELIZA_OK = 0;
export const ELIZA_ERR_NOT_IMPLEMENTED = -1;
export const ELIZA_ERR_INVALID_ARG = -2;
export const ELIZA_ERR_BUNDLE_INVALID = -3;
export const ELIZA_ERR_FFI_FAULT = -4;
export const ELIZA_ERR_OOM = -5;
export const ELIZA_ERR_ABI_MISMATCH = -6;

/**
 * Region names the lifecycle hands to `mmap_acquire` / `mmap_evict`.
 * Mirrors the set the C stub validates in `ffi-stub.c::valid_region`.
 */
export type ElizaInferenceRegion = "tts" | "asr" | "text" | "dflash";

/**
 * Opaque pointer to the C-side `EliInferenceContext`. Numeric on Bun
 * (FFI returns the raw pointer as `bigint`); never inspected on the JS
 * side beyond passing it back through the binding.
 */
export type ElizaInferenceContextHandle = bigint;

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

interface BunFfiModule {
  dlopen(path: string, defs: Record<string, unknown>): BunFfiLib;
  FFIType: Record<string, number>;
  ptr(value: ArrayBufferView): unknown;
  CString: new (ptr: unknown) => { toString(): string };
  read: { ptr(buf: unknown, offset?: number): bigint };
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
  try {
    lib = ffi.dlopen(dylibPath, {
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
    });
  } catch (err) {
    throw new VoiceLifecycleError(
      "kernel-missing",
      `[ffi-bindings] Failed to open libelizainference at ${dylibPath}: ${formatFfiError(err)}`,
    );
  }

  // ABI version check — refuse to run if the loaded library is not v1.
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
