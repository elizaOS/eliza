/**
 * bun:ffi binding for libomnivoice. Mirrors the pattern used by
 * plugins/plugin-aosp-local-inference (lazy `bun:ffi` import, typed
 * symbol map, OmnivoiceNotInstalled when the lib is missing).
 *
 * The binding talks to the public C ABI declared in
 * packages/inference/omnivoice.cpp/src/omnivoice.h. Struct layouts are
 * mirrored as ArrayBuffers and passed by pointer (bun:ffi cannot pass
 * structs by value). Field offsets are computed once at module load.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { logger } from "@elizaos/core";
import {
  OmnivoiceModelMissing,
  OmnivoiceNotInstalled,
  OmnivoiceSynthesisFailed,
} from "./errors";
import type {
  OmnivoiceContextOptions,
  OmnivoiceSynthesisResult,
} from "./types";

// ───────────────────────── ABI mirror ─────────────────────────
// Keep struct layout in lock-step with omnivoice.h. OV_ABI_VERSION
// must match what omnivoice was built with.
export const OV_ABI_VERSION = 2;

export const OV_STATUS_OK = 0;

const POINTER_SIZE = 8;
const I32 = 4;
const F32 = 4;
const U64 = 8;
const BOOL = 1;
// 8-byte alignment on common 64-bit ABIs (Linux/macOS/Windows x64, arm64).
const PTR_ALIGN = 8;

function align(offset: number, to: number): number {
  return (offset + (to - 1)) & ~(to - 1);
}

interface FieldLayout {
  offset: number;
  size: number;
}

function buildLayout(
  fields: ReadonlyArray<readonly [string, number, number]>,
): { size: number; fields: Record<string, FieldLayout> } {
  const result: Record<string, FieldLayout> = {};
  let offset = 0;
  let maxAlign = 1;
  for (const [name, size, fieldAlign] of fields) {
    offset = align(offset, fieldAlign);
    result[name] = { offset, size };
    offset += size;
    if (fieldAlign > maxAlign) maxAlign = fieldAlign;
  }
  return { size: align(offset, maxAlign), fields: result };
}

// struct ov_init_params { int abi_version; const char* model_path;
//   const char* codec_path; bool use_fa; bool clamp_fp16; }
export const OV_INIT_PARAMS_LAYOUT = buildLayout([
  ["abi_version", I32, 4],
  ["model_path", POINTER_SIZE, PTR_ALIGN],
  ["codec_path", POINTER_SIZE, PTR_ALIGN],
  ["use_fa", BOOL, 1],
  ["clamp_fp16", BOOL, 1],
]);

// struct ov_audio { float* samples; int n_samples; int sample_rate; int channels; }
export const OV_AUDIO_LAYOUT = buildLayout([
  ["samples", POINTER_SIZE, PTR_ALIGN],
  ["n_samples", I32, 4],
  ["sample_rate", I32, 4],
  ["channels", I32, 4],
]);

// struct ov_tts_params — see omnivoice.h. Captures every field in
// declaration order so default-init via ov_tts_default_params() lays
// the struct out correctly before we override the few fields we touch.
export const OV_TTS_PARAMS_LAYOUT = buildLayout([
  ["abi_version", I32, 4],
  ["text", POINTER_SIZE, PTR_ALIGN],
  ["lang", POINTER_SIZE, PTR_ALIGN],
  ["instruct", POINTER_SIZE, PTR_ALIGN],
  ["T_override", I32, 4],
  ["chunk_duration_sec", F32, 4],
  ["chunk_threshold_sec", F32, 4],
  ["denoise", BOOL, 1],
  ["preprocess_prompt", BOOL, 1],
  ["mg_num_step", I32, 4],
  ["mg_guidance_scale", F32, 4],
  ["mg_t_shift", F32, 4],
  ["mg_layer_penalty_factor", F32, 4],
  ["mg_position_temperature", F32, 4],
  ["mg_class_temperature", F32, 4],
  ["mg_seed", U64, 8],
  ["ref_audio_tokens", POINTER_SIZE, PTR_ALIGN],
  ["ref_T", I32, 4],
  ["ref_audio_24k", POINTER_SIZE, PTR_ALIGN],
  ["ref_n_samples", I32, 4],
  ["ref_text", POINTER_SIZE, PTR_ALIGN],
  ["dump_dir", POINTER_SIZE, PTR_ALIGN],
  ["cancel", POINTER_SIZE, PTR_ALIGN],
  ["cancel_user_data", POINTER_SIZE, PTR_ALIGN],
  ["on_chunk", POINTER_SIZE, PTR_ALIGN],
  ["on_chunk_user_data", POINTER_SIZE, PTR_ALIGN],
]);

// ───────────────────────── bun:ffi loader ─────────────────────────

interface OmnivoiceFFIFunctions {
  ov_version: () => bigint;
  ov_last_error: () => bigint;
  ov_init_default_params: (paramsPtr: bigint) => void;
  ov_init: (paramsPtr: bigint) => bigint;
  ov_free: (ctx: bigint) => void;
  ov_tts_default_params: (paramsPtr: bigint) => void;
  ov_synthesize: (
    ctx: bigint,
    paramsPtr: bigint,
    audioPtr: bigint,
  ) => number;
  ov_audio_free: (audioPtr: bigint) => void;
}

interface BunFFIJSCallback {
  readonly ptr: bigint | number;
  close: () => void;
}

interface BunFFIModule {
  dlopen: (
    p: string,
    symbols: Record<string, { args: readonly string[]; returns: string }>,
  ) => {
    symbols: OmnivoiceFFIFunctions;
    close: () => void;
  };
  ptr: (typed: ArrayBufferView) => bigint;
  toArrayBuffer: (
    ptr: bigint,
    byteOffset?: number,
    byteLength?: number,
  ) => ArrayBuffer;
  CString: new (
    addr: bigint,
    byteOffset?: number,
    byteLength?: number,
  ) => string;
  // `bun:ffi` exposes JSCallback as a constructor that produces a stable
  // C function pointer the native side can call back into JS. The handle
  // MUST be kept alive (and explicitly `close()`-ed after the call) — a
  // GC'd JSCallback leaves the native side dereferencing freed memory.
  JSCallback: new (
    fn: (...args: never[]) => unknown,
    def: { args: readonly string[]; returns: string },
  ) => BunFFIJSCallback;
}

interface OmnivoiceLibHandle {
  symbols: OmnivoiceFFIFunctions;
  ffi: BunFFIModule;
  close: () => void;
  libPath: string;
}

let cachedLib: OmnivoiceLibHandle | null = null;

function expectedDefaultLibName(): string {
  if (process.platform === "darwin") return "libomnivoice.dylib";
  if (process.platform === "win32") return "omnivoice.dll";
  return "libomnivoice.so";
}

function defaultLibSearchPaths(): string[] {
  const here = process.cwd();
  return [
    process.env.OMNIVOICE_LIB_PATH,
    path.join(
      here,
      "packages/inference/omnivoice.cpp/build",
      expectedDefaultLibName(),
    ),
    path.join(
      here,
      "../../packages/inference/omnivoice.cpp/build",
      expectedDefaultLibName(),
    ),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
}

async function loadBunFFI(): Promise<BunFFIModule> {
  // The string concat hides `bun:ffi` from non-Bun bundlers; tsc and
  // vitest never resolve it statically. Same trick the AOSP loader uses.
  const specifier = `bun${":"}ffi`;
  const mod = (await import(specifier)) as unknown as BunFFIModule;
  if (typeof mod?.dlopen !== "function") {
    throw new OmnivoiceNotInstalled(
      "bun:ffi unavailable in this runtime. Run under Bun, not Node.",
    );
  }
  return mod;
}

async function openLib(): Promise<OmnivoiceLibHandle> {
  if (cachedLib) return cachedLib;
  const ffi = await loadBunFFI();
  const candidates = defaultLibSearchPaths();
  const libPath = candidates.find((p) => existsSync(p));
  if (!libPath) {
    throw new OmnivoiceNotInstalled(
      `searched: ${candidates.join(", ") || "<no candidates>"}`,
    );
  }
  logger.info(`[plugin-omnivoice] dlopen(${libPath})`);
  let handle: ReturnType<typeof ffi.dlopen>;
  try {
    handle = ffi.dlopen(libPath, {
      ov_version: { args: [], returns: "ptr" },
      ov_last_error: { args: [], returns: "ptr" },
      ov_init_default_params: { args: ["ptr"], returns: "void" },
      ov_init: { args: ["ptr"], returns: "ptr" },
      ov_free: { args: ["ptr"], returns: "void" },
      ov_tts_default_params: { args: ["ptr"], returns: "void" },
      ov_synthesize: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
      ov_audio_free: { args: ["ptr"], returns: "void" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new OmnivoiceNotInstalled(`dlopen failed for ${libPath}: ${msg}`);
  }
  cachedLib = {
    symbols: handle.symbols,
    ffi,
    close: handle.close,
    libPath,
  };
  return cachedLib;
}

// ───────────────────────── pointer helpers ─────────────────────────

function getDataView(buf: Uint8Array): DataView {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

function readPointer(view: DataView, offset: number): bigint {
  return view.getBigUint64(offset, true);
}

function writePointer(view: DataView, offset: number, value: bigint): void {
  view.setBigUint64(offset, value, true);
}

// ───────────────────────── public class ─────────────────────────

export class OmnivoiceContext {
  private constructor(
    private readonly handle: OmnivoiceLibHandle,
    private readonly ctx: bigint,
    private readonly options: OmnivoiceContextOptions,
    /** Roots holding C-string buffers alive for the ctx lifetime. */
    private readonly retained: ArrayBufferView[],
  ) {}

  static async open(options: OmnivoiceContextOptions): Promise<OmnivoiceContext> {
    if (!options.modelPath || !existsSync(options.modelPath)) {
      throw new OmnivoiceModelMissing("model_path", options.modelPath);
    }
    if (!options.codecPath || !existsSync(options.codecPath)) {
      throw new OmnivoiceModelMissing("codec_path", options.codecPath);
    }

    const handle = await openLib();
    const { symbols, ffi } = handle;

    const paramsBuf = new Uint8Array(OV_INIT_PARAMS_LAYOUT.size);
    const paramsPtr = ffi.ptr(paramsBuf);
    symbols.ov_init_default_params(paramsPtr);

    const view = getDataView(paramsBuf);
    view.setInt32(
      OV_INIT_PARAMS_LAYOUT.fields.abi_version.offset,
      OV_ABI_VERSION,
      true,
    );

    const modelStr = encodeCString(options.modelPath);
    const codecStr = encodeCString(options.codecPath);
    writePointer(
      view,
      OV_INIT_PARAMS_LAYOUT.fields.model_path.offset,
      ffi.ptr(modelStr),
    );
    writePointer(
      view,
      OV_INIT_PARAMS_LAYOUT.fields.codec_path.offset,
      ffi.ptr(codecStr),
    );
    paramsBuf[OV_INIT_PARAMS_LAYOUT.fields.use_fa.offset] = options.useFa ?? true
      ? 1
      : 0;
    paramsBuf[OV_INIT_PARAMS_LAYOUT.fields.clamp_fp16.offset] =
      options.clampFp16 ? 1 : 0;

    const ctx = symbols.ov_init(paramsPtr);
    if (ctx === 0n) {
      const err = readLastError(handle);
      throw new OmnivoiceNotInstalled(
        `ov_init returned NULL${err ? `: ${err}` : ""}`,
      );
    }
    return new OmnivoiceContext(handle, ctx, options, [modelStr, codecStr]);
  }

  /** Underlying lib path (for diagnostics). */
  get libPath(): string {
    return this.handle.libPath;
  }

  /** Free the native context. Safe to call multiple times. */
  close(): void {
    if (this.ctx === 0n) return;
    this.handle.symbols.ov_free(this.ctx);
    // Drop retained buffers to allow GC.
    this.retained.length = 0;
  }

  /**
   * Run synthesis. The `prepareParams` callback receives the
   * already-defaulted ov_tts_params buffer; the caller writes any
   * fields it wants to override (text, lang, instruct, …) before
   * ov_synthesize is invoked. Pointer fields written into params
   * MUST be backed by buffers in the `retain` array — otherwise the
   * GC can collect them between write and call.
   *
   * When `onChunk` is provided, the streaming path is engaged: a
   * `bun:ffi` `JSCallback` is bound to the C `ov_audio_chunk_cb` slot
   * and invoked once per chunk during `ov_synthesize`. The C ABI
   * documents that `out` stays empty on success in this mode, so the
   * returned `samples` are accumulated from the chunks. The callback
   * may return `false` to request cancellation; the lib will surface
   * that as a synthesis failure status code.
   *
   * Sample rate is fixed by the codec (24 kHz mono — see omnivoice.h);
   * we read it from `out` when available and fall back to 24000 if the
   * streaming path leaves `out` zeroed.
   */
  async synthesize(
    prepareParams: (
      view: DataView,
      layout: typeof OV_TTS_PARAMS_LAYOUT,
      ffi: BunFFIModule,
      retain: (buf: ArrayBufferView) => void,
    ) => void,
    onChunk?: (chunk: OmnivoiceStreamingChunk) => boolean | void,
  ): Promise<OmnivoiceSynthesisResult> {
    const { symbols, ffi } = this.handle;
    const paramsBuf = new Uint8Array(OV_TTS_PARAMS_LAYOUT.size);
    const paramsPtr = ffi.ptr(paramsBuf);
    symbols.ov_tts_default_params(paramsPtr);
    const view = getDataView(paramsBuf);
    view.setInt32(
      OV_TTS_PARAMS_LAYOUT.fields.abi_version.offset,
      OV_ABI_VERSION,
      true,
    );

    const callRetained: ArrayBufferView[] = [paramsBuf];
    prepareParams(view, OV_TTS_PARAMS_LAYOUT, ffi, (b) => {
      callRetained.push(b);
    });

    // Streaming setup — only when caller provided onChunk. We allocate
    // and register the JSCallback here (after prepareParams ran) so the
    // caller cannot accidentally overwrite our on_chunk slot.
    let jsCallback: BunFFIJSCallback | null = null;
    const streamedChunks: Float32Array[] = [];
    let streamedTotal = 0;
    if (onChunk) {
      if (typeof ffi.JSCallback !== "function") {
        throw new OmnivoiceNotInstalled(
          "bun:ffi runtime does not expose JSCallback — streaming requires Bun >= 1.0",
        );
      }
      jsCallback = new ffi.JSCallback(
        ((samplesPtr: bigint, nSamples: number) => {
          // ov_audio_chunk_cb signature:
          //   bool (*)(const float *samples, int n_samples, void *user_data)
          // bun:ffi delivers pointer args as bigint, i32 args as number.
          // user_data is unused on the JS side — we forward NULL from C.
          const n = Number(nSamples);
          let pcm: Float32Array;
          if (n > 0 && samplesPtr !== 0n) {
            // Copy out of native memory before returning. The lib's
            // contract: buffer is valid only for the duration of this
            // call. Use .slice() to detach from the native ArrayBuffer.
            const ab = ffi.toArrayBuffer(samplesPtr, 0, n * F32).slice(0);
            pcm = new Float32Array(ab);
          } else {
            pcm = new Float32Array(0);
          }
          streamedChunks.push(pcm);
          streamedTotal += pcm.length;
          let keepGoing: boolean | void;
          try {
            keepGoing = onChunk({ samples: pcm });
          } catch (err) {
            // Surface JS callback errors as cancellation; do not let
            // them propagate into the native call stack.
            logger.error(
              `[plugin-omnivoice] onChunk threw: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            return 0;
          }
          // C bool return: 1 = continue, 0 = cancel. `void` means continue.
          return keepGoing === false ? 0 : 1;
        }) as unknown as (...args: never[]) => unknown,
        {
          // (samples: ptr, n_samples: i32, user_data: ptr) -> bool (i32)
          args: ["ptr", "i32", "ptr"],
          returns: "bool",
        },
      );
      writePointer(
        view,
        OV_TTS_PARAMS_LAYOUT.fields.on_chunk.offset,
        BigInt(jsCallback.ptr),
      );
      // on_chunk_user_data left at 0 — we have no per-call state.
    }

    const audioBuf = new Uint8Array(OV_AUDIO_LAYOUT.size);
    const audioPtr = ffi.ptr(audioBuf);
    callRetained.push(audioBuf);

    let status: number;
    try {
      status = symbols.ov_synthesize(this.ctx, paramsPtr, audioPtr);
    } finally {
      // Close the JSCallback *after* ov_synthesize returns. The lib
      // guarantees it will not retain the function pointer past the
      // call boundary.
      if (jsCallback) jsCallback.close();
    }
    if (status !== OV_STATUS_OK) {
      const err = readLastError(this.handle);
      throw new OmnivoiceSynthesisFailed(status, err);
    }

    const audioView = getDataView(audioBuf);
    const samplesPtr = readPointer(audioView, OV_AUDIO_LAYOUT.fields.samples.offset);
    const nSamples = audioView.getInt32(
      OV_AUDIO_LAYOUT.fields.n_samples.offset,
      true,
    );
    const sampleRate = audioView.getInt32(
      OV_AUDIO_LAYOUT.fields.sample_rate.offset,
      true,
    );
    const channels = audioView.getInt32(
      OV_AUDIO_LAYOUT.fields.channels.offset,
      true,
    );

    if (onChunk) {
      // Streaming path: `out` stays empty on success per the ABI.
      // Concatenate the streamed chunks for the caller's convenience.
      const samples = new Float32Array(streamedTotal);
      let off = 0;
      for (const c of streamedChunks) {
        samples.set(c, off);
        off += c.length;
      }
      // Sample rate / channels: prefer values the lib wrote into `out`
      // (some builds populate metadata even on the streaming path); fall
      // back to the codec defaults documented in omnivoice.h.
      return {
        samples,
        sampleRate: sampleRate > 0 ? sampleRate : 24000,
        channels: channels > 0 ? channels : 1,
      };
    }

    const byteLen = nSamples * F32;
    // Copy out of native memory before releasing — ov_audio_free invalidates
    // the underlying pointer.
    const native = ffi.toArrayBuffer(samplesPtr, 0, byteLen);
    const samples = new Float32Array(byteLen / F32);
    samples.set(new Float32Array(native));
    symbols.ov_audio_free(audioPtr);

    return { samples, sampleRate, channels };
  }
}

/** Argument shape for the streaming callback. */
export interface OmnivoiceStreamingChunk {
  /** Mono float PCM at the codec sample rate (24 kHz). */
  samples: Float32Array;
}

function encodeCString(s: string): Uint8Array {
  const enc = new TextEncoder().encode(s);
  const buf = new Uint8Array(enc.length + 1);
  buf.set(enc, 0);
  buf[enc.length] = 0;
  return buf;
}

function readLastError(handle: OmnivoiceLibHandle): string | undefined {
  try {
    const ptr = handle.symbols.ov_last_error();
    if (ptr === 0n) return undefined;
    const cstr = new handle.ffi.CString(ptr);
    return String(cstr) || undefined;
  } catch {
    return undefined;
  }
}

// ───────────────────────── exports for tests ─────────────────────────

/**
 * Test-only factory: build an OmnivoiceContext around a caller-provided
 * fake `BunFFIModule` + symbols. Lets unit tests exercise the streaming
 * callback wiring without dlopen-ing a real libomnivoice. Production
 * code MUST go through `OmnivoiceContext.open` instead.
 */
function createForTest(args: {
  symbols: OmnivoiceFFIFunctions;
  ffi: BunFFIModule;
  ctx?: bigint;
  options?: OmnivoiceContextOptions;
}): OmnivoiceContext {
  const handle: OmnivoiceLibHandle = {
    symbols: args.symbols,
    ffi: args.ffi,
    close: () => {},
    libPath: "<test-fake>",
  };
  // Cast through unknown to reach the private constructor — the only
  // place in the codebase that does this, gated behind _internal.
  const Ctor = OmnivoiceContext as unknown as new (
    handle: OmnivoiceLibHandle,
    ctx: bigint,
    options: OmnivoiceContextOptions,
    retained: ArrayBufferView[],
  ) => OmnivoiceContext;
  return new Ctor(
    handle,
    args.ctx ?? 0x1234n,
    args.options ?? { modelPath: "<fake>", codecPath: "<fake>" },
    [],
  );
}

export const _internal = {
  buildLayout,
  align,
  encodeCString,
  expectedDefaultLibName,
  defaultLibSearchPaths,
  createForTest,
};
