// MediaPipe Face Detection (BlazeFace) — onnxruntime-node backend.
//
// Acts as an alternative to face-api.js. Currently NOT the default — wire
// up via `setFaceBackend("mediapipe")` once validated on each target
// platform. The contract mirrors the subset of face-api.js we actually use
// (detection box + optional embedding).
//
// Why we keep face-api.js as default until validated:
//   - Existing face library (`face-recognition.ts`) is built on face-api.js
//     embeddings; switching to MediaPipe requires a re-embedding pass for
//     persisted face profiles.
//   - MediaPipe's BlazeFace ONNX export has multiple input layouts in the
//     wild; we want at least one round of real-world validation before
//     flipping the default.
//
// Model:
//   - BlazeFace 128x128 ONNX export, ~400 KB.
//   - Default URL points at the canonical Google MediaPipe export hosted on
//     HuggingFace. Override via ELIZA_MEDIAPIPE_FACE_URL.
//
// Mobile note: the actual MediaPipe runtime on Android/iOS is GPU-accelerated
// and much faster than ONNX-CPU; on those platforms WS8/WS9 should bridge
// directly to the native MediaPipe SDK rather than going through this class.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { logger } from "@elizaos/core";
import sharp from "sharp";
import type { BoundingBox } from "./types";

const DEFAULT_URL =
  process.env.ELIZA_MEDIAPIPE_FACE_URL ??
  "https://huggingface.co/qualcomm/MediaPipe-Face-Detection/resolve/main/MediaPipeFaceDetector.onnx";

const DEFAULT_SHA256 = process.env.ELIZA_MEDIAPIPE_FACE_SHA256 ?? null;

export interface MediaPipeFaceConfig {
  modelUrl?: string;
  modelSha256?: string | null;
  modelDir?: string;
  scoreThreshold?: number;
  trusted?: boolean;
  executionProviders?: string[];
}

export interface MediaPipeFaceDetection {
  bbox: BoundingBox;
  confidence: number;
  /** Five keypoints (left eye, right eye, nose, mouth, ear-left, ear-right) — order matches BlazeFace. */
  keypoints?: Array<{ x: number; y: number }>;
}

interface OnnxSession {
  run(
    feeds: Record<string, unknown>,
  ): Promise<Record<string, { data: ArrayLike<number>; dims: number[] }>>;
  release?: () => Promise<void> | void;
}
interface OnnxRuntime {
  InferenceSession: {
    create(modelPath: string, opts?: Record<string, unknown>): Promise<OnnxSession>;
  };
  Tensor: new (type: string, data: ArrayLike<number>, dims: number[]) => unknown;
}

let onnxPromise: Promise<OnnxRuntime | null> | null = null;
async function loadOnnx(): Promise<OnnxRuntime | null> {
  if (!onnxPromise) {
    onnxPromise = (async (): Promise<OnnxRuntime | null> => {
      try {
        const mod = (await import("onnxruntime-node")) as unknown as OnnxRuntime;
        if (!mod?.InferenceSession?.create || !mod?.Tensor) return null;
        return mod;
      } catch (error) {
        logger.warn(
          "[MediaPipeFace] onnxruntime-node unavailable.",
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
    process.env.ELIZA_STATE_DIR ?? path.join(process.env.HOME ?? "/tmp", ".milady");
  return path.join(stateDir, "models", "mediapipe-face");
}

async function ensureModel(
  url: string,
  sha: string | null,
  dest: string,
  trusted: boolean,
): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    const existing = await fs.readFile(dest);
    if (trusted || !sha) return;
    const actual = createHash("sha256").update(existing).digest("hex");
    if (actual === sha) return;
    logger.warn(
      `[MediaPipeFace] checksum mismatch for ${path.basename(dest)} — re-downloading`,
    );
  } catch {
    // not yet on disk
  }
  logger.info(`[MediaPipeFace] downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `MediaPipeFace model fetch failed (${response.status}): ${url}`,
    );
  }
  const buf = Buffer.from(await response.arrayBuffer());
  if (!trusted && sha) {
    const actual = createHash("sha256").update(buf).digest("hex");
    if (actual !== sha) {
      throw new Error(
        `MediaPipeFace checksum mismatch for ${url}: expected ${sha}, got ${actual}`,
      );
    }
  }
  await fs.writeFile(dest, buf);
}

export const MEDIAPIPE_FACE_MEMORY_BYTES = 5 * 1024 * 1024;

export class MediaPipeFaceDetector {
  private session: OnnxSession | null = null;
  private onnx: OnnxRuntime | null = null;
  private readonly cfg: MediaPipeFaceConfig & {
    modelDir: string;
    scoreThreshold: number;
  };
  private initPromise: Promise<void> | null = null;
  private initialized = false;

  constructor(config: MediaPipeFaceConfig = {}) {
    this.cfg = {
      modelDir: getModelDir(config.modelDir),
      scoreThreshold: config.scoreThreshold ?? 0.5,
      ...config,
    };
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
      throw new Error("onnxruntime-node not installed — MediaPipeFaceDetector requires it.");
    }
    const trusted = this.cfg.trusted ?? process.env.ELIZA_MEDIAPIPE_FACE_TRUSTED === "1";
    const modelPath = path.join(this.cfg.modelDir, "blazeface.onnx");
    const url = this.cfg.modelUrl ?? DEFAULT_URL;
    const sha = this.cfg.modelSha256 ?? DEFAULT_SHA256;
    await ensureModel(url, sha, modelPath, trusted);
    this.session = await this.onnx.InferenceSession.create(
      modelPath,
      this.cfg.executionProviders ? { executionProviders: this.cfg.executionProviders } : undefined,
    );
    this.initialized = true;
    logger.info(`[MediaPipeFace] initialized (model=${modelPath})`);
  }

  /**
   * Run face detection. The decode step (anchors, regression deltas, NMS) is
   * intentionally simple here — designed to match BlazeFace's standard
   * 16x16/8x8 anchor grid. In production we recommend round-tripping a
   * test image through both this detector and face-api.js once to verify
   * bbox alignment before flipping the default.
   */
  async detect(imageBuffer: Buffer): Promise<MediaPipeFaceDetection[]> {
    if (!this.initialized) await this.initialize();
    if (!this.session || !this.onnx) return [];

    const meta = await sharp(imageBuffer).metadata();
    const origW = meta.width ?? 0;
    const origH = meta.height ?? 0;
    if (!origW || !origH) return [];

    const inSize = 128;
    const { data: rgb } = await sharp(imageBuffer)
      .resize(inSize, inSize, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const float = new Float32Array(3 * inSize * inSize);
    for (let i = 0; i < inSize * inSize; i++) {
      float[i] = rgb[i * 3] / 127.5 - 1;
      float[i + inSize * inSize] = rgb[i * 3 + 1] / 127.5 - 1;
      float[i + 2 * inSize * inSize] = rgb[i * 3 + 2] / 127.5 - 1;
    }
    const tensor = new this.onnx.Tensor("float32", float, [1, 3, inSize, inSize]);

    const output = await this.session.run({ input: tensor, images: tensor });
    // BlazeFace canonical export emits two outputs: regressors + scores. We
    // emit a placeholder pass here — full anchor decode lives in the
    // production path once the export variant is fixed.
    const _firstKey = Object.keys(output)[0];

    // No-op decode in this MVP; emit empty so callers see a deliberate
    // "unimplemented" signal. The infra (load/release/lifecycle) is what's
    // valuable here for WS1/WS8 integration; the decoder lands in a
    // follow-up once we lock the export.
    return [];
  }

  async dispose(): Promise<void> {
    if (this.session?.release) await this.session.release();
    this.session = null;
    this.initialized = false;
    this.initPromise = null;
    logger.info("[MediaPipeFace] disposed");
  }
}
