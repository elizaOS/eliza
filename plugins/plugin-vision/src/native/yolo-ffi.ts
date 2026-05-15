// yolo-ffi.ts — bun:ffi binding for the yolo.cpp shared library.
//
// Mirrors `doctr-ffi.ts`. The native lib is built from
// `plugin-vision/native/yolo.cpp/`. The TS layer owns letterboxing, decode,
// and NMS — this binding is intentionally a thin pass-through to the C++
// forward pass.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "@elizaos/core";

const MODULE_TAG = "[yolo-ffi]";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function defaultLibraryPath(): string {
  const ext =
    process.platform === "darwin"
      ? "dylib"
      : process.platform === "win32"
        ? "dll"
        : "so";
  return (
    process.env.ELIZA_YOLO_LIB ??
    path.join(
      __dirname,
      "..",
      "..",
      "native",
      "yolo.cpp",
      "build",
      `libyolo.${ext}`,
    )
  );
}

export function defaultYoloWeightsPath(): string {
  const stateDir =
    process.env.ELIZA_STATE_DIR ??
    path.join(process.env.HOME ?? "/tmp", ".milady");
  return (
    process.env.ELIZA_YOLO_GGUF ??
    path.join(stateDir, "models", "vision", "yolov8n.gguf")
  );
}

interface YoloBindings {
  /** Run forward pass. Returns the raw (channels, anchors) logits tensor. */
  run(
    ggufPath: string,
    rgbCHW: Float32Array,
    h: number,
    w: number,
  ): Promise<{ logits: Float32Array; channels: number; anchors: number }>;

  /** Returns the embedded class names (newline-separated). */
  classes(ggufPath: string): Promise<string>;

  dispose(): Promise<void>;
}

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

let bindingsPromise: Promise<YoloBindings | null> | null = null;

export async function loadYoloBindings(): Promise<YoloBindings | null> {
  if (!bindingsPromise) {
    bindingsPromise = (async (): Promise<YoloBindings | null> => {
      const libPath = defaultLibraryPath();
      try {
        await fs.access(libPath);
      } catch {
        logger.warn(`${MODULE_TAG} native library not found at ${libPath}`);
        return null;
      }

      let bunFFI: BunFFIModule | null = null;
      try {
        const dynImport = new Function(
          "spec",
          "return import(spec)",
        ) as (s: string) => Promise<BunFFIModule>;
        bunFFI = await dynImport("bun:ffi");
      } catch {
        logger.warn(
          `${MODULE_TAG} bun:ffi unavailable — yolo.cpp requires bun runtime.`,
        );
        return null;
      }

      const { dlopen, FFIType, ptr, CString } = bunFFI;

      let lib;
      try {
        lib = dlopen(libPath, {
          yolo_init: { args: [FFIType.cstring], returns: FFIType.pointer },
          yolo_run: {
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
          yolo_classes: { args: [FFIType.pointer], returns: FFIType.cstring },
          yolo_free: { args: [FFIType.pointer], returns: FFIType.void },
        });
      } catch (error) {
        logger.warn(
          `${MODULE_TAG} dlopen failed for ${libPath}:`,
          error instanceof Error ? error.message : error,
        );
        return null;
      }

      const ctxCache = new Map<string, unknown>();

      async function ensureCtx(gguf: string): Promise<unknown> {
        const cached = ctxCache.get(gguf);
        if (cached) return cached;
        const cstr = Buffer.from(gguf + "\0", "utf-8");
        const handle = lib.symbols.yolo_init(ptr(cstr));
        if (!handle) {
          throw new Error(
            `yolo_init failed for ${gguf} — GGUF not present or invalid.`,
          );
        }
        ctxCache.set(gguf, handle);
        return handle;
      }

      return {
        async run(gguf, rgbCHW, h, w) {
          const ctx = await ensureCtx(gguf);
          const outChan = new Int32Array(1);
          const outAnch = new Int32Array(1);
          // Upper bound for YOLOv8: 84 channels * 8400 anchors = 705600 floats.
          const logits = new Float32Array(84 * 8400);
          const rc = lib.symbols.yolo_run(
            ctx as never,
            ptr(rgbCHW) as never,
            h,
            w,
            ptr(logits) as never,
            ptr(outChan) as never,
            ptr(outAnch) as never,
          );
          if (rc !== 0) {
            throw new Error(
              `yolo_run failed (code=${rc}) — ggml backend not yet wired or weights not built.`,
            );
          }
          return {
            logits,
            channels: outChan[0],
            anchors: outAnch[0],
          };
        },

        async classes(gguf) {
          const ctx = await ensureCtx(gguf);
          const ptrChars = lib.symbols.yolo_classes(ctx as never);
          if (!ptrChars) return "";
          return new CString(ptrChars as never).toString();
        },

        async dispose() {
          for (const handle of ctxCache.values()) {
            lib.symbols.yolo_free(handle as never);
          }
          ctxCache.clear();
        },
      };
    })();
  }
  return bindingsPromise;
}

export async function isYoloReady(opts?: {
  weightsPath?: string;
}): Promise<{ ready: boolean; reason?: string }> {
  const weightsPath = opts?.weightsPath ?? defaultYoloWeightsPath();
  try {
    await fs.access(weightsPath);
  } catch {
    return { ready: false, reason: `YOLO GGUF missing: ${weightsPath}` };
  }
  const bindings = await loadYoloBindings();
  if (!bindings) {
    return {
      ready: false,
      reason: `native library failed to load (expected at ${defaultLibraryPath()})`,
    };
  }
  return { ready: true };
}
