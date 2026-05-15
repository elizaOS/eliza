// YOLO object detector — ggml runtime via `native/yolo.cpp/`.
//
// Replaces COCO-SSD (TensorFlow.js) and the prior onnxruntime-node YOLO
// path. Default model is YOLOv8n COCO (80 classes). Weights are NOT bundled
// in the npm package — they're fetched / built into a per-user state dir
// (`<state-dir>/models/vision/yolov8n.gguf`).
//
// Pipeline:
//   1. Letterbox + RGB CHW normalize to 640x640 (this file).
//   2. Forward pass (yolo.cpp via bun:ffi).
//   3. parseYoloV8 — decode (cx, cy, w, h, scores) per anchor.
//   4. NMS.
//
// **No fallback.** If the native lib or GGUF is missing, init throws.

import { logger } from "@elizaos/core";
import sharp from "sharp";
import {
  defaultYoloWeightsPath,
  isYoloReady,
  loadYoloBindings,
} from "./native/yolo-ffi";
import type { DetectedObject } from "./types";

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

export interface YOLOConfig {
  /** GGUF weights path. Defaults to `<state-dir>/models/vision/yolov8n.gguf`. */
  weightsPath?: string;
  /** Class names override; defaults to COCO 80 or whatever's embedded in the GGUF. */
  classes?: string[];
  /** Score threshold for emitted detections. */
  scoreThreshold?: number;
  /** Non-max suppression IoU threshold. */
  nmsIouThreshold?: number;
  /** Restrict output to these COCO class names (case-insensitive). */
  classFilter?: string[];
}

interface Detection {
  classId: number;
  className: string;
  score: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export class YOLODetector {
  private readonly cfg: Required<
    Pick<YOLOConfig, "scoreThreshold" | "nmsIouThreshold" | "weightsPath">
  > &
    YOLOConfig;
  private initPromise: Promise<void> | null = null;
  private initialized = false;
  private classes: string[];
  private readonly classFilterLower: Set<string> | null;

  constructor(config: YOLOConfig = {}) {
    this.cfg = {
      weightsPath: config.weightsPath ?? defaultYoloWeightsPath(),
      scoreThreshold: config.scoreThreshold ?? 0.35,
      nmsIouThreshold: config.nmsIouThreshold ?? 0.5,
      ...config,
    };
    this.classes = config.classes ?? COCO_CLASSES;
    this.classFilterLower = config.classFilter
      ? new Set(config.classFilter.map((c) => c.toLowerCase()))
      : null;
  }

  static async isAvailable(opts?: { weightsPath?: string }): Promise<boolean> {
    const { ready } = await isYoloReady(opts);
    return ready;
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
    const { ready, reason } = await isYoloReady({
      weightsPath: this.cfg.weightsPath,
    });
    if (!ready) {
      throw new Error(
        `[YOLO] migration in progress; GGUF not ready (${reason ?? "unknown"}). ` +
          `Build the native lib at plugins/plugin-vision/native/yolo.cpp and run ` +
          `scripts/convert.py to produce yolov8n.gguf.`,
      );
    }
    const bindings = await loadYoloBindings();
    if (!bindings) {
      throw new Error(
        "[YOLO] native bindings failed to load after readiness check passed",
      );
    }
    // Prefer the GGUF-embedded class names when available. Fall back to the
    // hardcoded COCO list if the binding returns an empty string.
    const embedded = await bindings.classes(this.cfg.weightsPath);
    if (embedded && embedded.trim().length > 0) {
      this.classes = embedded.split(/\r?\n/).filter(Boolean);
    }
    this.initialized = true;
    logger.info(
      `[YOLO] initialized (weights=${this.cfg.weightsPath}, classes=${this.classes.length})`,
    );
  }

  async detect(imageBuffer: Buffer): Promise<DetectedObject[]> {
    if (!this.initialized) await this.initialize();
    const bindings = await loadYoloBindings();
    if (!bindings) {
      throw new Error("[YOLO] native bindings unavailable at detect time");
    }

    const meta = await sharp(imageBuffer).metadata();
    const origW = meta.width ?? 0;
    const origH = meta.height ?? 0;
    if (!origW || !origH) return [];

    // YOLOv8 expects 640x640 letterboxed RGB input, /255 normalization.
    const inSize = 640;
    const scale = Math.min(inSize / origW, inSize / origH);
    const padW = Math.round((inSize - origW * scale) / 2);
    const padH = Math.round((inSize - origH * scale) / 2);

    const { data: rgb } = await sharp(imageBuffer)
      .resize(Math.round(origW * scale), Math.round(origH * scale), {
        fit: "fill",
      })
      .extend({
        top: padH,
        bottom: inSize - Math.round(origH * scale) - padH,
        left: padW,
        right: inSize - Math.round(origW * scale) - padW,
        background: { r: 114, g: 114, b: 114, alpha: 1 },
      })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const float = new Float32Array(3 * inSize * inSize);
    for (let i = 0; i < inSize * inSize; i++) {
      float[i] = rgb[i * 3] / 255;
      float[i + inSize * inSize] = rgb[i * 3 + 1] / 255;
      float[i + 2 * inSize * inSize] = rgb[i * 3 + 2] / 255;
    }

    const { logits, channels, anchors } = await bindings.run(
      this.cfg.weightsPath,
      float,
      inSize,
      inSize,
    );

    const detections = this.parseYoloV8(
      logits,
      channels,
      anchors,
      scale,
      padW,
      padH,
    );

    const filtered = this.classFilterLower
      ? detections.filter((d) =>
          this.classFilterLower!.has(d.className.toLowerCase()),
        )
      : detections;

    return filtered.map((d, idx) => ({
      id: `yolo-${Date.now()}-${idx}`,
      type: d.className,
      confidence: d.score,
      boundingBox: { x: d.x, y: d.y, width: d.width, height: d.height },
    }));
  }

  /**
   * YOLOv8 raw output: (channels, anchors) where channels = 4 bbox + N classes.
   * Decode each anchor: bbox = (cx, cy, w, h); score = best class prob.
   */
  private parseYoloV8(
    logits: Float32Array,
    channels: number,
    anchors: number,
    scale: number,
    padW: number,
    padH: number,
  ): Detection[] {
    if (channels <= 4 || anchors <= 0) return [];
    const classCount = channels - 4;
    const dets: Detection[] = [];

    for (let a = 0; a < anchors; a++) {
      const cx = logits[0 * anchors + a];
      const cy = logits[1 * anchors + a];
      const w = logits[2 * anchors + a];
      const h = logits[3 * anchors + a];

      let bestClass = -1;
      let bestScore = 0;
      for (let c = 0; c < classCount; c++) {
        const v = logits[(4 + c) * anchors + a];
        if (v > bestScore) {
          bestScore = v;
          bestClass = c;
        }
      }
      if (bestScore < this.cfg.scoreThreshold || bestClass < 0) continue;
      const className = this.classes[bestClass] ?? `class_${bestClass}`;

      const x1 = (cx - w / 2 - padW) / scale;
      const y1 = (cy - h / 2 - padH) / scale;
      dets.push({
        classId: bestClass,
        className,
        score: bestScore,
        x: x1,
        y: y1,
        width: w / scale,
        height: h / scale,
      });
    }
    return this.nms(dets);
  }

  private nms(detections: Detection[]): Detection[] {
    const sorted = [...detections].sort((a, b) => b.score - a.score);
    const kept: Detection[] = [];
    while (sorted.length) {
      const top = sorted.shift()!;
      kept.push(top);
      for (let i = sorted.length - 1; i >= 0; i--) {
        if (this.iou(top, sorted[i]) > this.cfg.nmsIouThreshold)
          sorted.splice(i, 1);
      }
    }
    return kept;
  }

  private iou(a: Detection, b: Detection): number {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.width, b.x + b.width);
    const y2 = Math.min(a.y + a.height, b.y + b.height);
    if (x2 <= x1 || y2 <= y1) return 0;
    const inter = (x2 - x1) * (y2 - y1);
    const union = a.width * a.height + b.width * b.height - inter;
    return inter / union;
  }

  async dispose(): Promise<void> {
    const bindings = await loadYoloBindings();
    if (bindings) await bindings.dispose();
    this.initialized = false;
    this.initPromise = null;
    logger.info("[YOLO] disposed");
  }
}
