/**
 * ggml-backed BlazeFace binding for the native face-cpp detector surface.
 *
 * The C ABI is fixed, but native builds may report unsupported operations until
 * both the compiled library and BlazeFace GGUF artifact are present. Availability
 * checks return false until the full detector path can run, and public methods
 * fail clearly rather than falling back to another backend.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { logger, resolveAliasedEnvValue } from "@elizaos/core";
import { getSharp } from "./image/sharp-compat";
import type { BoundingBox } from "./types";

const MODULE_TAG = "[BlazeFaceGgml]";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Same shape the removed ONNX detector exported. Kept identical so callers can
 * select the native backend without reshaping results.
 */
export interface MediaPipeFaceConfig {
  modelUrl?: string;
  modelSha256?: string | null;
  modelDir?: string;
  scoreThreshold?: number;
  trusted?: boolean;
}

export interface MediaPipeFaceDetection {
  bbox: BoundingBox;
  confidence: number;
  /**
   * BlazeFace's 6 keypoints in canonical order:
   *   0: left eye   1: right eye   2: nose tip
   *   3: mouth      4: left ear    5: right ear
   * Coordinates are in source-image absolute pixels.
   */
  keypoints?: Array<{ x: number; y: number }>;
}

const FACE_DETECTOR_INPUT_SIZE = 128;
const FACE_DETECTOR_KEYPOINT_COUNT = 6;
const FACE_DETECTION_FLOATS = 5 + FACE_DETECTOR_KEYPOINT_COUNT * 2; // x,y,w,h,conf + 12

function defaultLibraryPath(): string {
  const ext =
    process.platform === "darwin"
      ? "dylib"
      : process.platform === "win32"
        ? "dll"
        : "so";
  return (
    process.env.ELIZA_FACE_CPP_LIB ??
    path.join(
      __dirname,
      "..",
      "..",
      "..",
      "packages",
      "native-plugins",
      "face-cpp",
      "build",
      `libface.${ext}`,
    )
  );
}

function defaultModelDir(): string {
  const stateDir =
    resolveAliasedEnvValue("ELIZA_STATE_DIR") ??
    path.join(os.homedir(), ".eliza");
  return path.join(stateDir, "models", "face-cpp");
}

function defaultDetWeightsPath(): string {
  return (
    process.env.ELIZA_FACE_CPP_DET_GGUF ??
    path.join(defaultModelDir(), "blazeface.gguf")
  );
}

/**
 * Minimal structural type for the bun:ffi pieces we need. Same trick as
 * `doctr-ffi.ts` — keeps this file typecheckable under plain Node tsc
 * without `bun-types` resolved on every downstream consumer.
 */
interface BunFFIModule {
  dlopen: (
    p: string,
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

interface FaceDetectBindings {
  open(ggufPath: string): unknown;
  detect(
    handle: unknown,
    rgb: Buffer,
    w: number,
    h: number,
    stride: number,
    conf: number,
    cap: number,
  ): { detections: Float32Array; count: number };
  close(handle: unknown): void;
  activeBackend(): string;
}

let bindingsPromise: Promise<FaceDetectBindings | null> | null = null;

async function loadBindings(): Promise<FaceDetectBindings | null> {
  if (bindingsPromise) return bindingsPromise;
  bindingsPromise = (async (): Promise<FaceDetectBindings | null> => {
    const libPath = defaultLibraryPath();
    try {
      await fs.access(libPath);
    } catch {
      logger.warn(`${MODULE_TAG} native library not found at ${libPath}`);
      return null;
    }

    let bunFFI: BunFFIModule | null = null;
    try {
      const dynImport = new Function("spec", "return import(spec)") as (
        s: string,
      ) => Promise<BunFFIModule>;
      bunFFI = await dynImport("bun:ffi");
    } catch {
      logger.warn(
        `${MODULE_TAG} bun:ffi unavailable — face-cpp requires bun runtime.`,
      );
      return null;
    }

    const { dlopen, FFIType, ptr } = bunFFI;

    let lib: ReturnType<typeof dlopen>;
    try {
      lib = dlopen(libPath, {
        face_detect_open: {
          args: [FFIType.cstring, FFIType.pointer],
          returns: FFIType.i32,
        },
        face_detect: {
          args: [
            FFIType.pointer,
            FFIType.pointer,
            FFIType.i32,
            FFIType.i32,
            FFIType.i32,
            FFIType.f32,
            FFIType.pointer,
            FFIType.u32,
            FFIType.pointer,
          ],
          returns: FFIType.i32,
        },
        face_detect_close: {
          args: [FFIType.pointer],
          returns: FFIType.i32,
        },
        face_active_backend: {
          args: [],
          returns: FFIType.cstring,
        },
      });
    } catch (error) {
      logger.warn(
        `${MODULE_TAG} dlopen failed for ${libPath}:`,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }

    const bindings: FaceDetectBindings = {
      open(ggufPath) {
        const cstr = Buffer.from(`${ggufPath}\0`, "utf-8");
        const handleSlot = new BigUint64Array(1);
        const rc = lib.symbols.face_detect_open(
          ptr(cstr) as never,
          ptr(handleSlot) as never,
        ) as number;
        if (rc !== 0) {
          throw new Error(
            `face_detect_open failed (rc=${rc}) — GGUF likely missing or invalid.`,
          );
        }
        const handle = handleSlot[0];
        if (handle === 0n) {
          throw new Error(`face_detect_open returned NULL handle`);
        }
        // bun:ffi pointer-typed args expect a Number, not a BigInt.
        return Number(handle);
      },
      detect(handle, rgb, w, h, stride, conf, cap) {
        // face_detection layout: 5 + 12 floats = 17 floats per record. We
        // round to 18 to keep the buffer 8-byte aligned per slot in case
        // the C struct grows padding on some ABIs; only the first 17
        // floats are read.
        const SLOT = FACE_DETECTION_FLOATS;
        const dets = new Float32Array(cap * SLOT);
        const countSlot = new BigUint64Array(1);
        const rc = lib.symbols.face_detect(
          handle as never,
          ptr(rgb) as never,
          w,
          h,
          stride,
          conf,
          ptr(dets) as never,
          cap,
          ptr(countSlot) as never,
        ) as number;
        if (rc !== 0 && rc !== -28 /* -ENOSPC */) {
          throw new Error(`face_detect failed (rc=${rc}).`);
        }
        return { detections: dets, count: Number(countSlot[0]) };
      },
      close(handle) {
        lib.symbols.face_detect_close(handle as never);
      },
      activeBackend() {
        const raw = lib.symbols.face_active_backend();
        if (raw == null) return "unknown";
        // bun:ffi cstring returns stringify cleanly via String(); the
        // CString constructor expects a numeric pointer and throws on
        // an already-decoded value.
        return String(raw);
      },
    };
    return bindings;
  })();
  return bindingsPromise;
}

/**
 * ggml-backed BlazeFace face detector. Mirrors the
 * `MediaPipeFaceDetector` compatibility surface — same constructor config,
 * same `MediaPipeFaceDetection` output shape.
 *
 * Currently disabled (`isAvailable()` returns `false`) until the
 * face-cpp model entries gain runtime implementations and a BlazeFace GGUF
 * artifact lands.
 */
export class BlazeFaceGgmlDetector {
  private readonly cfg: MediaPipeFaceConfig & {
    modelDir: string;
    scoreThreshold: number;
  };
  private bindings: FaceDetectBindings | null = null;
  private handle: unknown = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(config: MediaPipeFaceConfig = {}) {
    this.cfg = {
      modelDir: config.modelDir ?? defaultModelDir(),
      scoreThreshold: config.scoreThreshold ?? 0.5,
      ...config,
    };
  }

  /**
   * `true` only when both the native library AND the GGUF weights are
   * on disk. Loading them happens lazily in `initialize()`.
   */
  static async isAvailable(): Promise<boolean> {
    const libPath = defaultLibraryPath();
    try {
      await fs.access(libPath);
    } catch {
      return false;
    }
    try {
      await fs.access(defaultDetWeightsPath());
    } catch {
      return false;
    }
    const bindings = await loadBindings();
    return Boolean(bindings);
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._initialize();
    return this.initPromise;
  }

  private async _initialize(): Promise<void> {
    this.bindings = await loadBindings();
    if (!this.bindings) {
      throw new Error(
        `${MODULE_TAG} face-cpp library unavailable; build packages/native/plugins/face-cpp first.`,
      );
    }
    const ggufPath = defaultDetWeightsPath();
    try {
      await fs.access(ggufPath);
    } catch {
      throw new Error(
        `${MODULE_TAG} BlazeFace GGUF missing at ${ggufPath} — see scripts/blazeface_to_gguf.py.`,
      );
    }
    this.handle = this.bindings.open(ggufPath);
    this.initialized = true;
    logger.info(
      `${MODULE_TAG} initialized (backend=${this.bindings.activeBackend()})`,
    );
  }

  /**
   * Detect faces in the given image buffer. The buffer can be any
   * sharp-supported format (PNG, JPEG, raw); we resize/letterbox to
   * the BlazeFace 128x128 input via sharp, run the native detector,
   * then return source-pixel bboxes + 6 keypoints.
   */
  async detect(imageBuffer: Buffer): Promise<MediaPipeFaceDetection[]> {
    if (!this.initialized) await this.initialize();
    if (!this.bindings || !this.handle) return [];

    const sharp = await getSharp();
    const meta = await sharp(imageBuffer).metadata();
    const origW = meta.width ?? 0;
    const origH = meta.height ?? 0;
    if (!origW || !origH) return [];

    const inSize = FACE_DETECTOR_INPUT_SIZE;
    const { data: rgbResized } = await sharp(imageBuffer)
      .resize(inSize, inSize, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const cap = 16;
    const { detections, count } = this.bindings.detect(
      this.handle,
      rgbResized,
      inSize,
      inSize,
      inSize * 3,
      this.cfg.scoreThreshold,
      cap,
    );

    const out: MediaPipeFaceDetection[] = [];
    const sx = origW / inSize;
    const sy = origH / inSize;
    for (let i = 0; i < count && i < cap; i++) {
      const off = i * FACE_DETECTION_FLOATS;
      const x = detections[off + 0] * sx;
      const y = detections[off + 1] * sy;
      const w = detections[off + 2] * sx;
      const h = detections[off + 3] * sy;
      const confidence = detections[off + 4];
      const keypoints: Array<{ x: number; y: number }> = [];
      for (let kp = 0; kp < FACE_DETECTOR_KEYPOINT_COUNT; kp++) {
        keypoints.push({
          x: detections[off + 5 + kp * 2 + 0] * sx,
          y: detections[off + 5 + kp * 2 + 1] * sy,
        });
      }
      out.push({
        bbox: { x, y, width: w, height: h },
        confidence,
        keypoints,
      });
    }
    return out;
  }

  async dispose(): Promise<void> {
    if (this.bindings && this.handle) {
      this.bindings.close(this.handle);
    }
    this.handle = null;
    this.initialized = false;
    this.initPromise = null;
    logger.debug(`${MODULE_TAG} disposed`);
  }
}
