// YOLO object detector — yolo-cpp ggml/ref backend.
//
// Phase 2 — backed by `packages/native-plugins/yolo-cpp` (the standalone C
// library that ports Ultralytics YOLOv8n / YOLOv11n away from
// onnxruntime). Falls through to the onnxruntime path
// (`yolo-detector.ts`) when:
//   - `bun:ffi` isn't available (non-Bun runtime),
//   - the native shared library hasn't been built yet,
//   - the native library returns -ENOSYS for `yolo_detect` (the
//     forward pass is staged — see
//     `packages/native-plugins/yolo-cpp/src/yolo_runtime.c` TU header).
//
// Public surface mirrors `YOLODetector` from `yolo-detector.ts` byte-
// for-byte so `person-detector.ts` (and any other consumer) can swap
// the import without behavioural change.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { logger } from "@elizaos/core";
import sharp from "sharp";
import type { DetectedObject } from "./types";

const MODULE_TAG = "[yolo-ggml]";

/* ---------- defaults & lookup helpers --------------------------------- */

const COCO_CLASSES = [
  "person",
  "bicycle",
  "car",
  "motorcycle",
  "airplane",
  "bus",
  "train",
  "truck",
  "boat",
  "traffic light",
  "fire hydrant",
  "stop sign",
  "parking meter",
  "bench",
  "bird",
  "cat",
  "dog",
  "horse",
  "sheep",
  "cow",
  "elephant",
  "bear",
  "zebra",
  "giraffe",
  "backpack",
  "umbrella",
  "handbag",
  "tie",
  "suitcase",
  "frisbee",
  "skis",
  "snowboard",
  "sports ball",
  "kite",
  "baseball bat",
  "baseball glove",
  "skateboard",
  "surfboard",
  "tennis racket",
  "bottle",
  "wine glass",
  "cup",
  "fork",
  "knife",
  "spoon",
  "bowl",
  "banana",
  "apple",
  "sandwich",
  "orange",
  "broccoli",
  "carrot",
  "hot dog",
  "pizza",
  "donut",
  "cake",
  "chair",
  "couch",
  "potted plant",
  "bed",
  "dining table",
  "toilet",
  "tv",
  "laptop",
  "mouse",
  "remote",
  "keyboard",
  "cell phone",
  "microwave",
  "oven",
  "toaster",
  "sink",
  "refrigerator",
  "book",
  "clock",
  "vase",
  "scissors",
  "teddy bear",
  "hair drier",
  "toothbrush",
];

const INPUT_SIZE = 640;

// errno-style negative codes the C runtime returns. Kept as a small
// allow-list so the binding can distinguish "staged forward path" from
// real errors without leaking errno tables to callers.
const ERRNO_ENOSYS = -38;

function defaultGgufPath(): string {
  const stateDir =
    process.env.ELIZA_STATE_DIR ??
    path.join(process.env.HOME ?? "/tmp", ".milady");
  return (
    process.env.ELIZA_YOLO_GGUF ??
    path.join(stateDir, "models", "yolo", "yolov8n.gguf")
  );
}

function defaultLibraryPath(): string {
  const ext =
    process.platform === "darwin"
      ? "dylib"
      : process.platform === "win32"
        ? "dll"
        : "so";
  // The yolo-cpp CMake build emits both libyolo.a (static) and
  // libyolo.{so,dylib,dll} (shared). bun:ffi consumes the shared one.
  return (
    process.env.ELIZA_YOLO_CPP_LIB ??
    path.join(
      process.cwd(),
      "packages",
      "native-plugins",
      "yolo-cpp",
      "build",
      `libyolo.${ext}`,
    )
  );
}

/* ---------- public config & shape ------------------------------------- */

export interface YOLOGgmlConfig {
  /** Path to the GGUF emitted by `yolo_to_gguf.py`. */
  ggufPath?: string;
  /** Score threshold for emitted detections. */
  scoreThreshold?: number;
  /** Non-max suppression IoU threshold. */
  nmsIouThreshold?: number;
  /** Class names override; defaults to COCO 80. */
  classes?: string[];
  /** Restrict output to these COCO class names (case-insensitive). */
  classFilter?: string[];
}

/* ---------- yolo-cpp binding contract --------------------------------- */

interface YoloCppDetection {
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
  classId: number;
}

interface YoloCppBindings {
  open(ggufPath: string): unknown /* opaque handle pointer */;
  detect(
    handle: unknown,
    rgb: Uint8Array,
    width: number,
    height: number,
    confThreshold: number,
    iouThreshold: number,
  ): { rc: number; detections: YoloCppDetection[] };
  close(handle: unknown): void;
  activeBackend(): string;
}

/* The bun:ffi module is loaded dynamically because this file also has
 * to import-cleanly under non-Bun runtimes (for example the cloud
 * worker that uses the onnxruntime path exclusively). */
interface BunFFIModule {
  dlopen: (
    path: string,
    symbols: Record<string, { args: number[]; returns: number }>,
  ) => {
    symbols: Record<string, (...args: unknown[]) => unknown>;
  };
  FFIType: Record<
    | "cstring"
    | "pointer"
    | "i32"
    | "i64"
    | "void"
    | "f32"
    | "u8"
    | "u32"
    | "u64",
    number
  >;
  ptr: (typedArray: ArrayBufferView) => unknown;
  read: {
    f32: (p: unknown, offset: number) => number;
    i32: (p: unknown, offset: number) => number;
  };
  CString: new (raw: unknown) => { toString(): string };
}

let bindingPromise: Promise<YoloCppBindings | null> | null = null;
async function loadYoloCppBindings(): Promise<YoloCppBindings | null> {
  if (!bindingPromise) {
    bindingPromise = (async (): Promise<YoloCppBindings | null> => {
      const libPath = defaultLibraryPath();
      try {
        await fs.access(libPath);
      } catch {
        // The yolo-cpp shared lib isn't built. That's the expected
        // case in the cloud / browser path. Return null so the
        // YOLODetector consumer falls through to the ONNX detector.
        logger.info(
          `${MODULE_TAG} libyolo not present at ${libPath} — falling back to onnxruntime path`,
        );
        return null;
      }

      let bunFFI: BunFFIModule | null = null;
      try {
        // Dynamic import keeps the static graph clean for non-Bun
        // runtimes that statically analyse imports.
        const dynImport = new Function("spec", "return import(spec)") as (
          s: string,
        ) => Promise<BunFFIModule>;
        bunFFI = await dynImport("bun:ffi");
      } catch {
        logger.warn(
          `${MODULE_TAG} bun:ffi unavailable — yolo-cpp requires the bun runtime; falling back`,
        );
        return null;
      }

      const { dlopen, FFIType, ptr, read } = bunFFI;

      // Detection record layout (must match yolo_detection in
      // include/yolo/yolo.h byte-for-byte):
      //   float x, y, w, h, confidence;  (5 * 4 = 20 bytes)
      //   int class_id;                  (4 bytes)
      //   total = 24 bytes per record.
      const DET_BYTES = 24;
      const DET_CAP = 256;

      let lib;
      try {
        lib = dlopen(libPath, {
          // int yolo_open(const char *gguf, yolo_handle *out);
          yolo_open: {
            args: [FFIType.cstring, FFIType.pointer],
            returns: FFIType.i32,
          },
          // int yolo_detect(handle, image*, conf, iou, out, cap, *count);
          yolo_detect: {
            args: [
              FFIType.pointer, // handle
              FFIType.pointer, // image*
              FFIType.f32, // conf_threshold
              FFIType.f32, // iou_threshold
              FFIType.pointer, // out*
              FFIType.u64, // out_cap
              FFIType.pointer, // out_count*
            ],
            returns: FFIType.i32,
          },
          yolo_close: { args: [FFIType.pointer], returns: FFIType.i32 },
          yolo_active_backend: { args: [], returns: FFIType.cstring },
        });
      } catch (error) {
        logger.warn(
          `${MODULE_TAG} dlopen failed for ${libPath}: ${
            error instanceof Error ? error.message : String(error)
          } — falling back to onnxruntime path`,
        );
        return null;
      }

      const symbols = lib.symbols;

      function activeBackend(): string {
        const raw = symbols.yolo_active_backend();
        if (raw == null) return "unknown";
        // bun:ffi already returns a CString (cstring-typed return),
        // which stringifies cleanly. Re-wrapping in `new CString(raw)`
        // expects a numeric pointer and throws on the wrapped object.
        return String(raw);
      }

      function open(ggufPath: string): unknown {
        const cstr = Buffer.from(ggufPath + "\0", "utf-8");
        // Out parameter for yolo_handle (a pointer-sized slot).
        const handleSlot = new BigInt64Array(1);
        const rc = symbols.yolo_open(
          ptr(cstr) as never,
          ptr(handleSlot) as never,
        ) as number;
        if (rc !== 0) {
          throw new Error(
            `${MODULE_TAG} yolo_open(${ggufPath}) returned errno ${rc}`,
          );
        }
        const handle = handleSlot[0];
        if (handle === 0n) {
          throw new Error(`${MODULE_TAG} yolo_open returned NULL handle`);
        }
        // bun:ffi pointer-typed args need a Number, not a BigInt — keep
        // the handle as a Number from here on so call sites never
        // re-convert.
        return Number(handle);
      }

      function detect(
        handle: unknown,
        rgb: Uint8Array,
        width: number,
        height: number,
        confThreshold: number,
        iouThreshold: number,
      ): { rc: number; detections: YoloCppDetection[] } {
        // yolo_image struct: rgb*, w, h, stride. Lay it out byte-by-
        // byte to match include/yolo/yolo.h. The struct is 24 bytes:
        // 8 (pointer) + 4 + 4 + 4 + 4 (tail pad for 8-byte alignment).
        const imgStruct = new Uint8Array(24);
        const imgView = new DataView(imgStruct.buffer);
        const rgbPtr = ptr(rgb);
        imgView.setBigUint64(0, BigInt(rgbPtr as unknown as number), true);
        imgView.setInt32(8, width, true);
        imgView.setInt32(12, height, true);
        imgView.setInt32(16, width * 3, true);

        const out = new Uint8Array(DET_BYTES * DET_CAP);
        const outCount = new BigUint64Array(1);

        const rc = symbols.yolo_detect(
          handle as never,
          ptr(imgStruct) as never,
          confThreshold,
          iouThreshold,
          ptr(out) as never,
          BigInt(DET_CAP) as never,
          ptr(outCount) as never,
        ) as number;

        if (rc !== 0) {
          return { rc, detections: [] };
        }
        const n = Number(outCount[0]);
        const detections: YoloCppDetection[] = [];
        const view = new DataView(out.buffer);
        for (let i = 0; i < n && i < DET_CAP; i++) {
          const off = i * DET_BYTES;
          detections.push({
            x: view.getFloat32(off + 0, true),
            y: view.getFloat32(off + 4, true),
            w: view.getFloat32(off + 8, true),
            h: view.getFloat32(off + 12, true),
            confidence: view.getFloat32(off + 16, true),
            classId: view.getInt32(off + 20, true),
          });
        }
        // `read` is intentionally unused below — the DataView path is
        // sufficient and avoids one extra round-trip per field. Keep
        // the import live so the contract is one block.
        void read;
        return { rc: 0, detections };
      }

      function close(handle: unknown): void {
        symbols.yolo_close(handle as never);
      }

      return { open, detect, close, activeBackend };
    })();
  }
  return bindingPromise;
}

/* ---------- detector --------------------------------------------------- */

interface InternalDetection extends YoloCppDetection {
  className: string;
}

export class YOLODetector {
  private handle: unknown = null;
  private bindings: YoloCppBindings | null = null;
  private readonly cfg: Required<
    Pick<YOLOGgmlConfig, "ggufPath" | "scoreThreshold" | "nmsIouThreshold">
  > &
    YOLOGgmlConfig;
  private initPromise: Promise<void> | null = null;
  private initialized = false;
  private readonly classes: string[];
  private readonly classFilterLower: Set<string> | null;

  constructor(config: YOLOGgmlConfig = {}) {
    this.cfg = {
      ggufPath: config.ggufPath ?? defaultGgufPath(),
      scoreThreshold: config.scoreThreshold ?? 0.35,
      nmsIouThreshold: config.nmsIouThreshold ?? 0.5,
      ...config,
    };
    this.classes = config.classes ?? COCO_CLASSES;
    this.classFilterLower = config.classFilter
      ? new Set(config.classFilter.map((c) => c.toLowerCase()))
      : null;
  }

  static async isAvailable(): Promise<boolean> {
    return Boolean(await loadYoloCppBindings());
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
    this.bindings = await loadYoloCppBindings();
    if (!this.bindings) {
      throw new Error(
        `${MODULE_TAG} yolo-cpp ggml backend not available — falling back to onnxruntime path is the caller's responsibility (see plugins/plugin-vision/src/yolo-detector.ts).`,
      );
    }
    try {
      await fs.access(this.cfg.ggufPath);
    } catch {
      throw new Error(
        `${MODULE_TAG} GGUF missing at ${this.cfg.ggufPath} — run packages/native-plugins/yolo-cpp/scripts/yolo_to_gguf.py first.`,
      );
    }
    this.handle = this.bindings.open(this.cfg.ggufPath);
    this.initialized = true;
    logger.info(
      `${MODULE_TAG} initialized (gguf=${this.cfg.ggufPath} backend=${this.bindings.activeBackend()})`,
    );
  }

  async detect(imageBuffer: Buffer): Promise<DetectedObject[]> {
    if (!this.initialized) await this.initialize();
    if (!this.bindings || !this.handle) return [];

    const meta = await sharp(imageBuffer).metadata();
    const origW = meta.width;
    const origH = meta.height;
    if (!origW || !origH) return [];

    // The C library's yolo_detect takes the source image directly
    // and runs its own letterbox internally (yolo_letterbox.c). The
    // TS layer just hands over a tightly-packed RGB plane.
    const { data: rgbBuf } = await sharp(imageBuffer)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const rgb = new Uint8Array(rgbBuf.buffer, rgbBuf.byteOffset, rgbBuf.length);

    const { rc, detections: raw } = this.bindings.detect(
      this.handle,
      rgb,
      origW,
      origH,
      this.cfg.scoreThreshold,
      this.cfg.nmsIouThreshold,
    );

    if (rc === ERRNO_ENOSYS) {
      // Forward pass staged — log once per process and return empty.
      // Caller decides whether to fall back; the typical path is the
      // service layer racing this against yolo-detector.ts and
      // picking whichever returns.
      logger.warn(
        `${MODULE_TAG} yolo_detect returned -ENOSYS (forward pass staged in yolo_runtime.c). Falling back to empty detections; the onnxruntime path remains the production detector until Phase 3.`,
      );
      return [];
    }
    if (rc !== 0) {
      throw new Error(`${MODULE_TAG} yolo_detect failed with errno ${rc}`);
    }

    // The C library returns boxes already un-letterboxed into source
    // coordinates (per the C ABI doc). The TS layer only attaches a
    // class name and applies the optional class filter.
    const detections: InternalDetection[] = raw.map((d) => ({
      ...d,
      className: this.classes[d.classId] ?? `class_${d.classId}`,
    }));

    const filtered = this.classFilterLower
      ? detections.filter((d) =>
          this.classFilterLower!.has(d.className.toLowerCase()),
        )
      : detections;

    return filtered.map((d, idx) => ({
      id: `yolo-ggml-${Date.now()}-${idx}`,
      type: d.className,
      confidence: d.confidence,
      boundingBox: { x: d.x, y: d.y, width: d.w, height: d.h },
    }));
  }

  async dispose(): Promise<void> {
    if (this.bindings && this.handle) {
      this.bindings.close(this.handle);
    }
    this.handle = null;
    this.initialized = false;
    this.initPromise = null;
    logger.info(`${MODULE_TAG} disposed`);
  }
}
