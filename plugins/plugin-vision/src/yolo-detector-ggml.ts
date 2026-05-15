// YOLO object detector — ggml backend.
//
// EXPERIMENTAL — backed by `packages/native-plugins/yolo-cpp` (the
// standalone C library that ports Ultralytics YOLOv8n / YOLOv11n to the
// elizaOS/llama.cpp fork's ggml dispatcher). Falls through to the
// onnxruntime path (`yolo-detector.ts`) until yolo-cpp Phase 2 ships
// the ggml graph and a converted GGUF is available on disk.
//
// Public surface mirrors `YOLODetector` from `yolo-detector.ts` byte-
// for-byte so `person-detector.ts` (and any other consumer) can swap
// the import without behavioural change.
//
// Phase 1 contract (today):
//   - The C library exposes a stable ABI in
//     `packages/native-plugins/yolo-cpp/include/yolo/yolo.h`.
//   - `yolo_open` / `yolo_detect` return -ENOSYS from the stub. This
//     binding therefore reports `isAvailable() === false` until both
//     (a) the native library is built AND (b) a Phase 2 implementation
//     of the ggml-backed entry points is linked in. Until then the
//     onnxruntime path stays primary; this file only matters for code
//     that explicitly opts into the experimental backend (e.g. via
//     `ELIZA_YOLO_BACKEND=ggml`).
//
// Phase 2 contract (when yolo-cpp ships its real graph):
//   - `loadYoloCppBindings()` returns a working binding. `initialize()`
//     calls `yolo_open` with the GGUF emitted by
//     `packages/native-plugins/yolo-cpp/scripts/yolo_to_gguf.py`.
//   - `detect()` letterboxes the input, calls `yolo_detect`, and maps
//     each `yolo_detection` to the `DetectedObject` shape consumed by
//     plugin-vision's service layer.

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
  // The yolo-cpp CMake build emits a static archive today; the Phase 2
  // shared-library target lives at the same `build/` location. Keep the
  // env-var override as the primary knob until the desktop installer
  // resolves the bundled binary.
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

/* The binding reflects `include/yolo/yolo.h` one-for-one. The struct
 * layout is the same as the C ABI — we own the marshalling so the
 * native side does not need to expose a JS-friendly variant. */

interface YoloCppDetection {
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
  classId: number;
}

interface YoloCppBindings {
  open(ggufPath: string): Promise<unknown /* opaque handle */>;
  detect(
    handle: unknown,
    rgb: Uint8Array,
    width: number,
    height: number,
    confThreshold: number,
    iouThreshold: number,
  ): Promise<YoloCppDetection[]>;
  close(handle: unknown): Promise<void>;
  activeBackend(): string;
}

/*
 * Loader. Returns null when the binding is not usable yet (Phase 1
 * stub; native library missing; bun:ffi unavailable). The on-disk
 * library is only required at the moment a real binding lands — the
 * Phase 1 stub returns `null` here so callers fall back to the ONNX
 * path without spurious dlopen errors.
 */
let bindingPromise: Promise<YoloCppBindings | null> | null = null;
async function loadYoloCppBindings(): Promise<YoloCppBindings | null> {
  if (!bindingPromise) {
    bindingPromise = (async (): Promise<YoloCppBindings | null> => {
      const libPath = defaultLibraryPath();
      try {
        await fs.access(libPath);
      } catch {
        // Phase 1: the native library may not be built. That is the
        // expected case until yolo-cpp ships its Phase 2 graph.
        return null;
      }
      // Phase 2 will dlopen via `bun:ffi` here and bind the four
      // entry points (`yolo_open`, `yolo_detect`, `yolo_close`,
      // `yolo_active_backend`). Returning null today documents the
      // boundary and keeps callers on the ONNX fallback. The dlopen
      // wiring will land alongside the ggml backend in the same
      // commit so this file does not advertise capabilities the
      // native side cannot actually deliver.
      return null;
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
    this.handle = await this.bindings.open(this.cfg.ggufPath);
    this.initialized = true;
    logger.info(
      `${MODULE_TAG} initialized (gguf=${this.cfg.ggufPath} backend=${this.bindings.activeBackend()})`,
    );
  }

  async detect(imageBuffer: Buffer): Promise<DetectedObject[]> {
    if (!this.initialized) await this.initialize();
    if (!this.bindings || !this.handle) return [];

    const meta = await sharp(imageBuffer).metadata();
    const origW = meta.width ?? 0;
    const origH = meta.height ?? 0;
    if (!origW || !origH) return [];

    // Letterbox to YOLO_INPUT_SIZE, RGB, /255-equivalent (the C side
    // takes uint8 and does its own normalization).
    const scale = Math.min(INPUT_SIZE / origW, INPUT_SIZE / origH);
    const padW = Math.round((INPUT_SIZE - origW * scale) / 2);
    const padH = Math.round((INPUT_SIZE - origH * scale) / 2);

    const { data: rgbBuf } = await sharp(imageBuffer)
      .resize(Math.round(origW * scale), Math.round(origH * scale), {
        fit: "fill",
      })
      .extend({
        top: padH,
        bottom: INPUT_SIZE - Math.round(origH * scale) - padH,
        left: padW,
        right: INPUT_SIZE - Math.round(origW * scale) - padW,
        background: { r: 114, g: 114, b: 114, alpha: 1 },
      })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const rgb = new Uint8Array(rgbBuf.buffer, rgbBuf.byteOffset, rgbBuf.length);

    const raw = await this.bindings.detect(
      this.handle,
      rgb,
      INPUT_SIZE,
      INPUT_SIZE,
      this.cfg.scoreThreshold,
      this.cfg.nmsIouThreshold,
    );

    // The C library returns letterboxed-coordinate boxes in input
    // pixel space. Un-letterbox here so the caller receives source-
    // image absolute coordinates (matches the onnxruntime path).
    const detections: InternalDetection[] = [];
    for (const det of raw) {
      const className = this.classes[det.classId] ?? `class_${det.classId}`;
      detections.push({
        ...det,
        className,
        x: (det.x - padW) / scale,
        y: (det.y - padH) / scale,
        w: det.w / scale,
        h: det.h / scale,
      });
    }

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
      await this.bindings.close(this.handle);
    }
    this.handle = null;
    this.initialized = false;
    this.initPromise = null;
    logger.info(`${MODULE_TAG} disposed`);
  }
}
