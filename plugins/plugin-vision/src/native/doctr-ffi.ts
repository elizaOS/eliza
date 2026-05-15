// doctr-ffi.ts — bun:ffi binding for the doctr.cpp shared library.
//
// The native library is built from `plugin-vision/native/doctr.cpp/` and emits
// `libdoctr.<dylib|so|dll>`. The convention matches `plugin-local-inference`'s
// llama.cpp binding (see that plugin's `src/native/` for the canonical pattern).
//
// Until the native lib has been built AND the GGUF weight files exist, every
// public function here throws a clear error. There is no silent fallback.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "@elizaos/core";

const MODULE_TAG = "[doctr-ffi]";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Where the runtime expects to find the compiled native library. */
function defaultLibraryPath(): string {
  const ext =
    process.platform === "darwin"
      ? "dylib"
      : process.platform === "win32"
        ? "dll"
        : "so";
  return (
    process.env.ELIZA_DOCTR_LIB ??
    path.join(
      __dirname,
      "..",
      "..",
      "native",
      "doctr.cpp",
      "build",
      `libdoctr.${ext}`,
    )
  );
}

/** Where the runtime expects GGUF weights. */
export function defaultDetWeightsPath(): string {
  const stateDir =
    process.env.ELIZA_STATE_DIR ??
    path.join(process.env.HOME ?? "/tmp", ".milady");
  return (
    process.env.ELIZA_DOCTR_DET_GGUF ??
    path.join(stateDir, "models", "vision", "doctr-det.gguf")
  );
}

export function defaultRecWeightsPath(): string {
  const stateDir =
    process.env.ELIZA_STATE_DIR ??
    path.join(process.env.HOME ?? "/tmp", ".milady");
  return (
    process.env.ELIZA_DOCTR_REC_GGUF ??
    path.join(stateDir, "models", "vision", "doctr-rec.gguf")
  );
}

/**
 * Minimal structural type for the parts of `bun:ffi` we use. Lets the file
 * typecheck under plain Node tsc without requiring `bun-types` on every
 * downstream consumer.
 */
interface BunFFIModule {
  dlopen: (
    path: string,
    symbols: Record<string, { args: number[]; returns: number }>,
  ) => {
    symbols: Record<string, (...args: unknown[]) => unknown>;
  };
  FFIType: Record<
    "cstring" | "pointer" | "i32" | "void" | "f32" | "u8" | "u32",
    number
  >;
  ptr: (typedArray: ArrayBufferView) => unknown;
  CString: new (raw: unknown) => { toString(): string };
}

interface DocTRBindings {
  /** Detection forward pass. Output: prob map at H/4 × W/4. */
  detect(
    detGGUFPath: string,
    rgbCHW: Float32Array,
    h: number,
    w: number,
  ): Promise<{ probMap: Float32Array; h: number; w: number }>;

  /** Recognition forward pass on a cropped line image. */
  recognize(
    recGGUFPath: string,
    rgbCHW: Float32Array,
    h: number,
    w: number,
  ): Promise<{ logits: Float32Array; T: number; C: number }>;

  /** Returns the recognition charset (utf-8, newline separated). */
  charset(recGGUFPath: string): Promise<string>;

  dispose(): Promise<void>;
}

let bindingsPromise: Promise<DocTRBindings | null> | null = null;

/**
 * Load the doctr.cpp shared library via `bun:ffi`. Returns null when either
 * the library or the GGUF weights are missing — the caller is expected to
 * throw a clear error in that case rather than silently fall back.
 */
export async function loadDoctrBindings(): Promise<DocTRBindings | null> {
  if (!bindingsPromise) {
    bindingsPromise = (async (): Promise<DocTRBindings | null> => {
      const libPath = defaultLibraryPath();
      try {
        await fs.access(libPath);
      } catch {
        logger.warn(`${MODULE_TAG} native library not found at ${libPath}`);
        return null;
      }

      // bun:ffi import is dynamic so the module is importable from non-bun
      // hosts (electrobun preload may run plain Node in some surfaces).
      // We avoid a static `import("bun:ffi")` type reference here so plain
      // Node tsc doesn't need bun-types resolved — the runtime guard above
      // already gates the call site.
      let bunFFI: BunFFIModule | null = null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const dynImport = new Function(
          "spec",
          "return import(spec)",
        ) as (s: string) => Promise<BunFFIModule>;
        bunFFI = await dynImport("bun:ffi");
      } catch {
        logger.warn(
          `${MODULE_TAG} bun:ffi unavailable — doctr.cpp requires bun runtime.`,
        );
        return null;
      }

      const { dlopen, FFIType, ptr, CString } = bunFFI;

      // The native symbol table — names match `include/doctr.h`.
      // NOTE: until the C++ side is fully wired against ggml the symbols exist
      // but their `_run` functions return DOCTR_ERR_BACKEND. The TS adapter
      // converts that to a thrown Error so the OCR service falls through to
      // its next backend (apple-vision on darwin) or throws to the caller.
      let lib;
      try {
        lib = dlopen(libPath, {
          doctr_det_init: { args: [FFIType.cstring], returns: FFIType.pointer },
          doctr_det_run: {
            args: [
              FFIType.pointer,
              FFIType.pointer,
              FFIType.i32,
              FFIType.i32,
              FFIType.pointer,
              FFIType.pointer,
              FFIType.pointer,
            ],
            returns: FFIType.i32,
          },
          doctr_det_free: { args: [FFIType.pointer], returns: FFIType.void },
          doctr_rec_init: { args: [FFIType.cstring], returns: FFIType.pointer },
          doctr_rec_run: {
            args: [
              FFIType.pointer,
              FFIType.pointer,
              FFIType.i32,
              FFIType.i32,
              FFIType.pointer,
              FFIType.pointer,
              FFIType.pointer,
            ],
            returns: FFIType.i32,
          },
          doctr_rec_charset: {
            args: [FFIType.pointer],
            returns: FFIType.cstring,
          },
          doctr_rec_free: { args: [FFIType.pointer], returns: FFIType.void },
        });
      } catch (error) {
        logger.warn(
          `${MODULE_TAG} dlopen failed for ${libPath}:`,
          error instanceof Error ? error.message : error,
        );
        return null;
      }

      const detCtxCache = new Map<string, unknown>();
      const recCtxCache = new Map<string, unknown>();

      async function ensureDetCtx(gguf: string): Promise<unknown> {
        const cached = detCtxCache.get(gguf);
        if (cached) return cached;
        const cstr = Buffer.from(gguf + "\0", "utf-8");
        const handle = lib.symbols.doctr_det_init(ptr(cstr));
        if (!handle) {
          throw new Error(
            `doctr_det_init failed for ${gguf} — GGUF likely not present or invalid.`,
          );
        }
        detCtxCache.set(gguf, handle);
        return handle;
      }

      async function ensureRecCtx(gguf: string): Promise<unknown> {
        const cached = recCtxCache.get(gguf);
        if (cached) return cached;
        const cstr = Buffer.from(gguf + "\0", "utf-8");
        const handle = lib.symbols.doctr_rec_init(ptr(cstr));
        if (!handle) {
          throw new Error(
            `doctr_rec_init failed for ${gguf} — GGUF likely not present or invalid.`,
          );
        }
        recCtxCache.set(gguf, handle);
        return handle;
      }

      const bindings: DocTRBindings = {
        async detect(gguf, rgbCHW, h, w) {
          const ctx = await ensureDetCtx(gguf);
          const outH = new Int32Array(1);
          const outW = new Int32Array(1);
          // Worst case (h/4 × w/4) buffer pre-allocation.
          const prob = new Float32Array((h / 4) * (w / 4));
          const rc = lib.symbols.doctr_det_run(
            ctx as never,
            ptr(rgbCHW) as never,
            h,
            w,
            ptr(prob) as never,
            ptr(outH) as never,
            ptr(outW) as never,
          );
          if (rc !== 0) {
            throw new Error(
              `doctr_det_run failed (code=${rc}) — ggml backend not yet wired or weights not built.`,
            );
          }
          return { probMap: prob, h: outH[0], w: outW[0] };
        },

        async recognize(gguf, rgbCHW, h, w) {
          const ctx = await ensureRecCtx(gguf);
          const outT = new Int32Array(1);
          const outC = new Int32Array(1);
          // Generous upper bound: max charset ~256 entries, T = w/8.
          const logits = new Float32Array(Math.ceil(w / 8) * 512);
          const rc = lib.symbols.doctr_rec_run(
            ctx as never,
            ptr(rgbCHW) as never,
            h,
            w,
            ptr(logits) as never,
            ptr(outT) as never,
            ptr(outC) as never,
          );
          if (rc !== 0) {
            throw new Error(
              `doctr_rec_run failed (code=${rc}) — ggml backend not yet wired or weights not built.`,
            );
          }
          return { logits, T: outT[0], C: outC[0] };
        },

        async charset(gguf) {
          const ctx = await ensureRecCtx(gguf);
          const ptrChars = lib.symbols.doctr_rec_charset(ctx as never);
          if (!ptrChars) return "";
          return new CString(ptrChars as never).toString();
        },

        async dispose() {
          for (const handle of detCtxCache.values()) {
            lib.symbols.doctr_det_free(handle as never);
          }
          for (const handle of recCtxCache.values()) {
            lib.symbols.doctr_rec_free(handle as never);
          }
          detCtxCache.clear();
          recCtxCache.clear();
        },
      };

      return bindings;
    })();
  }
  return bindingsPromise;
}

/**
 * `true` when both the native library and the GGUF weights exist on disk. Does
 * not actually initialize anything — callers should still expect the C++ side
 * to return DOCTR_ERR_BACKEND until the ggml graph is wired.
 */
export async function isDoctrReady(opts?: {
  detPath?: string;
  recPath?: string;
}): Promise<{ ready: boolean; reason?: string }> {
  const detPath = opts?.detPath ?? defaultDetWeightsPath();
  const recPath = opts?.recPath ?? defaultRecWeightsPath();
  try {
    await fs.access(detPath);
  } catch {
    return { ready: false, reason: `detection GGUF missing: ${detPath}` };
  }
  try {
    await fs.access(recPath);
  } catch {
    return { ready: false, reason: `recognition GGUF missing: ${recPath}` };
  }
  const bindings = await loadDoctrBindings();
  if (!bindings) {
    return {
      ready: false,
      reason: `native library failed to load (expected at ${defaultLibraryPath()})`,
    };
  }
  return { ready: true };
}
