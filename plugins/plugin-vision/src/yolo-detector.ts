// YOLO object detector — onnxruntime-node
//
// Replaces COCO-SSD (TensorFlow.js) with YOLOv8n / YOLOv11n. The default
// model is YOLOv8n COCO (80 classes, ~6.2 MB, ~10ms/frame on a modern CPU).
//
// Reference models — ALL hostable from Hugging Face / Ultralytics ONNX
// releases. We do NOT bundle weights in the npm package; they're fetched
// on first use to <state-dir>/models/yolo/ with sha256 verification.
//
// Cross-platform notes:
//   - Linux x64/arm64 / macOS arm64 / Windows x64: onnxruntime-node CPU EP.
//   - macOS arm64 with CoreML: pass `executionProviders: ["coreml","cpu"]`.
//   - Windows + DirectML: pass `executionProviders: ["dml","cpu"]`.
//   - iOS / Android: a Capacitor/AOSP plugin wires Core ML / NNAPI. The JS
//     surface there should mirror this `YOLODetector` so the calling code
//     stays platform-agnostic. Owned by WS8 + WS9.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { logger } from "@elizaos/core";
import sharp from "sharp";
import type { DetectedObject } from "./types";

const DEFAULT_MODEL_URL =
  process.env.ELIZA_YOLO_MODEL_URL ??
  "https://huggingface.co/Ultralytics/YOLOv8/resolve/main/yolov8n.onnx";

const DEFAULT_MODEL_SHA256 = process.env.ELIZA_YOLO_MODEL_SHA256 ?? null;

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
  modelUrl?: string;
  modelSha256?: string | null;
  modelDir?: string;
  /** Class names override; defaults to COCO 80. */
  classes?: string[];
  /** Score threshold for emitted detections. */
  scoreThreshold?: number;
  /** Non-max suppression IoU threshold. */
  nmsIouThreshold?: number;
  /** Bypass sha256 check (or set ELIZA_YOLO_TRUSTED=1). */
  trusted?: boolean;
  executionProviders?: string[];
  /** Restrict output to these COCO class names (case-insensitive). */
  classFilter?: string[];
}

interface OnnxSession {
  run(
    feeds: Record<string, unknown>,
  ): Promise<Record<string, { data: ArrayLike<number>; dims: number[] }>>;
  release?: () => Promise<void> | void;
}
interface OnnxRuntime {
  InferenceSession: {
    create(
      modelPath: string,
      opts?: Record<string, unknown>,
    ): Promise<OnnxSession>;
  };
  Tensor: new (
    type: string,
    data: ArrayLike<number>,
    dims: number[],
  ) => unknown;
}

let onnxPromise: Promise<OnnxRuntime | null> | null = null;
async function loadOnnx(): Promise<OnnxRuntime | null> {
  if (!onnxPromise) {
    onnxPromise = (async (): Promise<OnnxRuntime | null> => {
      try {
        const mod = (await import(
          "onnxruntime-node"
        )) as unknown as OnnxRuntime;
        if (!mod?.InferenceSession?.create || !mod?.Tensor) return null;
        return mod;
      } catch (error) {
        logger.warn(
          "[YOLO] onnxruntime-node unavailable — YOLO backend disabled.",
          error instanceof Error ? error.message : error,
        );
        return null;
      }
    })();
  }
  return onnxPromise;
}

function getModelDir(custom?: string): string {
  if (custom) return custom;
  const stateDir =
    process.env.ELIZA_STATE_DIR ??
    path.join(process.env.HOME ?? "/tmp", ".milady");
  return path.join(stateDir, "models", "yolo");
}

async function ensureModelOnDisk(
  url: string,
  sha256: string | null,
  dest: string,
  trusted: boolean,
): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    const existing = await fs.readFile(dest);
    if (trusted || !sha256) return;
    const actual = createHash("sha256").update(existing).digest("hex");
    if (actual === sha256) return;
    logger.warn(
      `[YOLO] checksum mismatch for ${path.basename(dest)} — re-downloading`,
    );
  } catch {
    // not yet on disk
  }
  logger.info(`[YOLO] downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`YOLO model fetch failed (${response.status}): ${url}`);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  if (!trusted && sha256) {
    const actual = createHash("sha256").update(buf).digest("hex");
    if (actual !== sha256) {
      throw new Error(
        `YOLO checksum mismatch for ${url}: expected ${sha256}, got ${actual}`,
      );
    }
  }
  await fs.writeFile(dest, buf);
}

interface Detection {
  classId: number;
  className: string;
  score: number;
  /** Bbox in original image coords. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export class YOLODetector {
  private session: OnnxSession | null = null;
  private onnx: OnnxRuntime | null = null;
  private readonly cfg: Required<
    Pick<YOLOConfig, "modelDir" | "scoreThreshold" | "nmsIouThreshold">
  > &
    YOLOConfig;
  private initPromise: Promise<void> | null = null;
  private initialized = false;
  private readonly classes: string[];
  private readonly classFilterLower: Set<string> | null;

  constructor(config: YOLOConfig = {}) {
    this.cfg = {
      modelDir: getModelDir(config.modelDir),
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
    return Boolean(await loadOnnx());
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
    this.onnx = await loadOnnx();
    if (!this.onnx) {
      throw new Error(
        "onnxruntime-node not installed — YOLODetector requires it.",
      );
    }
    const trusted = this.cfg.trusted ?? process.env.ELIZA_YOLO_TRUSTED === "1";
    const modelPath = path.join(this.cfg.modelDir, "yolo.onnx");
    const url = this.cfg.modelUrl ?? DEFAULT_MODEL_URL;
    const sha256 = this.cfg.modelSha256 ?? DEFAULT_MODEL_SHA256;
    await ensureModelOnDisk(url, sha256, modelPath, trusted);
    this.session = await this.onnx.InferenceSession.create(
      modelPath,
      this.cfg.executionProviders
        ? { executionProviders: this.cfg.executionProviders }
        : undefined,
    );
    this.initialized = true;
    logger.info(`[YOLO] initialized (model=${modelPath})`);
  }

  async detect(imageBuffer: Buffer): Promise<DetectedObject[]> {
    if (!this.initialized) await this.initialize();
    if (!this.session || !this.onnx) return [];

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
    const tensor = new this.onnx.Tensor("float32", float, [
      1,
      3,
      inSize,
      inSize,
    ]);
    // Feed under common YOLO export names; runtime picks the right one.
    const output = await this.session.run({ images: tensor, input: tensor });
    const firstKey = Object.keys(output)[0];
    const raw = output[firstKey];
    if (!raw) return [];

    const detections = this.parseYoloV8(raw, inSize, scale, padW, padH);
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

  private parseYoloV8(
    output: { data: ArrayLike<number>; dims: number[] },
    inSize: number,
    scale: number,
    padW: number,
    padH: number,
  ): Detection[] {
    // YOLOv8 raw output: [1, 84, 8400] where the 84 = 4 bbox + 80 class
    // scores. We transpose to [8400, 84] in memory access.
    const dims = output.dims;
    if (dims.length !== 3) return [];
    const channels = dims[1];
    const anchors = dims[2];
    const classCount = channels - 4;
    if (classCount <= 0) return [];
    const data = output.data;
    const dets: Detection[] = [];

    for (let a = 0; a < anchors; a++) {
      // bbox cx, cy, w, h
      const cx = Number(data[0 * anchors + a]);
      const cy = Number(data[1 * anchors + a]);
      const w = Number(data[2 * anchors + a]);
      const h = Number(data[3 * anchors + a]);

      let bestClass = -1;
      let bestScore = 0;
      for (let c = 0; c < classCount; c++) {
        const v = Number(data[(4 + c) * anchors + a]);
        if (v > bestScore) {
          bestScore = v;
          bestClass = c;
        }
      }
      if (bestScore < this.cfg.scoreThreshold || bestClass < 0) continue;
      const className = this.classes[bestClass] ?? `class_${bestClass}`;

      // Convert from letterboxed input coords back to original image.
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
    if (this.session?.release) await this.session.release();
    this.session = null;
    this.initialized = false;
    this.initPromise = null;
    logger.info("[YOLO] disposed");
  }
}
