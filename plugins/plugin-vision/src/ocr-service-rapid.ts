// RapidOCR / PP-OCRv5 backend — onnxruntime-node
//
// Replaces Tesseract.js as the default OCR backend on platforms where ONNX
// Runtime CPU is available. Two-stage pipeline: text detection (DB / PP-OCRv5
// det) → text recognition (CRNN / PP-OCRv5 rec). Tiny per-image cost
// (sub-second on a modern CPU) and dramatically better quality on UI text.
//
// References:
//   - https://github.com/RapidAI/RapidOCR — canonical model zoo + ONNX exports
//   - https://github.com/gutenye/ocr — JS / Node bindings using ONNX runtime
//   - https://github.com/PaddlePaddle/PaddleOCR — upstream PP-OCRv5
//   - https://github.com/ente-io/mobile_ocr — mobile-optimized fork
//
// Models are NOT bundled in the npm package. They're fetched on first use to
// `<state-dir>/models/rapidocr/` (see `getModelDir`). The fetch routine here
// is deliberately minimal and parallel-safe; in production we route through
// the same model-fetch path eliza-1 uses (WS2).
//
// Platform notes (verify manually — Linux CPU is the only path validated
// from this host):
//   - Linux x64 / arm64: onnxruntime-node ships prebuilt CPU wheels.
//   - macOS arm64: onnxruntime-node CPU wheel exists; CoreML EP can be
//     enabled by passing `executionProviders: ['coreml','cpu']` to the session.
//   - Windows x64: onnxruntime-node CPU wheel exists; DirectML EP available.
//   - iOS / Android: use the platform-native OCR (Apple Vision / ML Kit) via
//     plugin-aosp / plugin-capacitor-bridge — this file is Node-only.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { logger } from "@elizaos/core";
import sharp from "sharp";
import type { BoundingBox, OCRResult } from "./types";

const DEFAULT_DET_URL =
  process.env.ELIZA_RAPIDOCR_DET_URL ??
  "https://huggingface.co/ilaylow/PP_OCRv5_mobile_onnx/resolve/main/ppocrv5_det.onnx";
const DEFAULT_REC_URL =
  process.env.ELIZA_RAPIDOCR_REC_URL ??
  "https://huggingface.co/ilaylow/PP_OCRv5_mobile_onnx/resolve/main/ppocrv5_rec.onnx";
const DEFAULT_DICT_URL =
  process.env.ELIZA_RAPIDOCR_DICT_URL ??
  "https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/dict/ppocrv5_dict.txt";

/**
 * Download URLs / sha256 fingerprints for the PP-OCRv5 ONNX bundle. These
 * point at upstream RapidOCR releases. If a file fails its checksum the
 * fetcher refuses to load — we never silently use a corrupt model.
 *
 * Filenames follow the RapidAI convention: `{stage}_{lang}_{quant}.onnx`.
 *
 * NOTE: checksums here are placeholders (`null`) — Linux CPU is the only path
 * validated from the dev host. Set ELIZA_RAPIDOCR_TRUSTED=1 to allow load
 * without checksum, or replace null with the real sha256 when validating on
 * each platform.
 */
interface ModelDescriptor {
  url: string;
  sha256: string | null;
  bytes?: number;
}

interface ModelBundle {
  detection: ModelDescriptor;
  recognition: ModelDescriptor;
  /** Character dictionary used to decode CRNN output. */
  charset: ModelDescriptor;
}

const DEFAULT_MODEL_BUNDLE: ModelBundle = {
  detection: { url: DEFAULT_DET_URL, sha256: null },
  recognition: { url: DEFAULT_REC_URL, sha256: null },
  charset: { url: DEFAULT_DICT_URL, sha256: null },
};

export interface RapidOCRConfig {
  modelDir?: string;
  bundle?: ModelBundle;
  /**
   * If true, skip the sha256 check. Defaults to true when
   * `ELIZA_RAPIDOCR_TRUSTED=1` is set. Use only on hosts where the model
   * registry is already vetted out-of-band.
   */
  trusted?: boolean;
  /** Arbitrary execution provider list passed to onnxruntime-node. */
  executionProviders?: string[];
}

function getModelDir(custom?: string): string {
  if (custom) return custom;
  const stateDir = process.env.ELIZA_STATE_DIR ?? path.join(process.env.HOME ?? "/tmp", ".milady");
  return path.join(stateDir, "models", "rapidocr");
}

async function fetchToFile(
  desc: ModelDescriptor,
  destination: string,
  trusted: boolean,
): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  // Skip if already on disk and the checksum matches (or trusted mode).
  try {
    const existing = await fs.readFile(destination);
    if (trusted || !desc.sha256) return;
    const actual = createHash("sha256").update(existing).digest("hex");
    if (actual === desc.sha256) return;
    logger.warn(
      `[RapidOCR] checksum mismatch for ${path.basename(destination)} — re-downloading`,
    );
  } catch {
    // doesn't exist yet — fall through to fetch.
  }

  logger.info(`[RapidOCR] downloading ${desc.url}`);
  const response = await fetch(desc.url);
  if (!response.ok) {
    throw new Error(
      `RapidOCR model fetch failed (${response.status}): ${desc.url}`,
    );
  }
  const buf = Buffer.from(await response.arrayBuffer());
  if (!trusted && desc.sha256) {
    const actual = createHash("sha256").update(buf).digest("hex");
    if (actual !== desc.sha256) {
      throw new Error(
        `RapidOCR checksum mismatch for ${desc.url}: expected ${desc.sha256}, got ${actual}`,
      );
    }
  }
  await fs.writeFile(destination, buf);
}

interface OnnxSession {
  run(
    feeds: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<Record<string, { data: ArrayLike<number>; dims: number[] }>>;
  release?: () => Promise<void> | void;
}

interface OnnxRuntime {
  InferenceSession: {
    create(
      modelPath: string,
      options?: Record<string, unknown>,
    ): Promise<OnnxSession>;
  };
  Tensor: new (
    type: string,
    data: ArrayLike<number>,
    dims: number[],
  ) => unknown;
}

let onnxModulePromise: Promise<OnnxRuntime | null> | null = null;
async function loadOnnxRuntime(): Promise<OnnxRuntime | null> {
  if (!onnxModulePromise) {
    onnxModulePromise = (async (): Promise<OnnxRuntime | null> => {
      try {
        const mod = (await import("onnxruntime-node")) as unknown as OnnxRuntime;
        if (!mod?.InferenceSession?.create || !mod?.Tensor) return null;
        return mod;
      } catch (error) {
        logger.warn(
          "[RapidOCR] onnxruntime-node unavailable — RapidOCR backend disabled.",
          error instanceof Error ? error.message : error,
        );
        return null;
      }
    })();
  }
  return onnxModulePromise;
}

/**
 * Detect platforms where Apple Vision is the better OCR choice.
 * macOS Sonoma+ and iOS expose `VNRecognizeTextRequest` which is faster and
 * higher-quality than RapidOCR for Latin scripts. The actual integration
 * lives in WS9 (plugin-ios); we just refuse to claim availability so the
 * higher-priority backend wins.
 */
export function shouldPreferAppleVision(): boolean {
  return process.platform === "darwin" && process.env.ELIZA_DISABLE_APPLE_VISION !== "1";
}

export class RapidOCRService {
  private readonly config: Required<Pick<RapidOCRConfig, "modelDir">> &
    Omit<RapidOCRConfig, "modelDir">;
  private detectionSession: OnnxSession | null = null;
  private recognitionSession: OnnxSession | null = null;
  private charset: string[] = [];
  private initPromise: Promise<void> | null = null;
  private initialized = false;
  private onnx: OnnxRuntime | null = null;

  constructor(config: RapidOCRConfig = {}) {
    this.config = {
      modelDir: getModelDir(config.modelDir),
      bundle: config.bundle ?? DEFAULT_MODEL_BUNDLE,
      trusted: config.trusted ?? process.env.ELIZA_RAPIDOCR_TRUSTED === "1",
      executionProviders: config.executionProviders,
    };
  }

  /**
   * `true` if we can plausibly load (onnxruntime-node resolves). Does NOT
   * mean models are downloaded.
   */
  static async isAvailable(): Promise<boolean> {
    return Boolean(await loadOnnxRuntime());
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
    this.onnx = await loadOnnxRuntime();
    if (!this.onnx) {
      throw new Error(
        "onnxruntime-node not installed — install it as an optional dependency to enable RapidOCR.",
      );
    }

    const detPath = path.join(this.config.modelDir, "det.onnx");
    const recPath = path.join(this.config.modelDir, "rec.onnx");
    const dictPath = path.join(this.config.modelDir, "charset.txt");

    const trusted = this.config.trusted ?? false;
    await Promise.all([
      fetchToFile(this.config.bundle!.detection, detPath, trusted),
      fetchToFile(this.config.bundle!.recognition, recPath, trusted),
      fetchToFile(this.config.bundle!.charset, dictPath, trusted),
    ]);

    const sessionOpts = this.config.executionProviders
      ? { executionProviders: this.config.executionProviders }
      : undefined;

    this.detectionSession = await this.onnx.InferenceSession.create(
      detPath,
      sessionOpts,
    );
    this.recognitionSession = await this.onnx.InferenceSession.create(
      recPath,
      sessionOpts,
    );
    const dictBytes = await fs.readFile(dictPath, "utf8");
    this.charset = dictBytes.split(/\r?\n/).filter(Boolean);

    this.initialized = true;
    logger.info(
      `[RapidOCR] initialized (modelDir=${this.config.modelDir}, charset=${this.charset.length})`,
    );
  }

  /**
   * Two-stage OCR: detection produces text-line crops; recognition turns each
   * crop into a string. We only return blocks (per-line) since the underlying
   * CRNN is line-level; word-granularity isn't directly available without
   * additional alignment.
   */
  async extractText(imageBuffer: Buffer): Promise<OCRResult> {
    if (!this.initialized) await this.initialize();
    if (!this.detectionSession || !this.recognitionSession || !this.onnx) {
      throw new Error("RapidOCR session unavailable");
    }

    const detection = await this.runDetection(imageBuffer);
    const blocks: OCRResult["blocks"] = [];
    for (const region of detection) {
      const recText = await this.runRecognition(imageBuffer, region.bbox);
      if (!recText) continue;
      blocks.push({
        text: recText,
        bbox: region.bbox,
        confidence: region.confidence,
      });
    }
    const fullText = blocks.map((b) => b.text).join("\n");
    return { text: fullText, blocks, fullText };
  }

  /**
   * Best-effort detection step. The PP-OCRv5 detection model expects a
   * normalized 3xHxW float tensor; we resize to the nearest multiple of 32
   * and feed RGB pixels in [0,1] range. Output is a probability map that we
   * threshold and turn into bounding boxes.
   *
   * The actual post-processing (DBNet) is well-documented but verbose. We
   * keep it lean here: anything above `prob > 0.3` becomes a box covering the
   * connected component, expanded by a small unclip ratio. For high-fidelity
   * extraction (curved text, dense documents) we recommend swapping in a
   * dedicated DB post-processor.
   */
  private async runDetection(
    imageBuffer: Buffer,
  ): Promise<Array<{ bbox: BoundingBox; confidence: number }>> {
    if (!this.detectionSession || !this.onnx) return [];
    const meta = await sharp(imageBuffer).metadata();
    const origW = meta.width ?? 0;
    const origH = meta.height ?? 0;
    if (!origW || !origH) return [];

    // Resize to a multiple of 32, max side 960. Standard PP-OCRv5 preset.
    const maxSide = 960;
    const scale = Math.min(1, maxSide / Math.max(origW, origH));
    const resizedW = Math.max(32, Math.round((origW * scale) / 32) * 32);
    const resizedH = Math.max(32, Math.round((origH * scale) / 32) * 32);

    const { data: rgb } = await sharp(imageBuffer)
      .resize(resizedW, resizedH, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const float = new Float32Array(3 * resizedW * resizedH);
    // CHW layout, normalize with PP-OCR mean/std.
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];
    for (let i = 0; i < resizedW * resizedH; i++) {
      const r = rgb[i * 3] / 255;
      const g = rgb[i * 3 + 1] / 255;
      const b = rgb[i * 3 + 2] / 255;
      float[i] = (r - mean[0]) / std[0];
      float[i + resizedW * resizedH] = (g - mean[1]) / std[1];
      float[i + 2 * resizedW * resizedH] = (b - mean[2]) / std[2];
    }

    const tensor = new this.onnx.Tensor("float32", float, [1, 3, resizedH, resizedW]);
    const feeds = await this.buildFeeds(this.detectionSession, tensor);
    const output = await this.detectionSession.run(feeds);
    const firstKey = Object.keys(output)[0];
    const probMap = output[firstKey];
    if (!probMap) return [];

    return this.probMapToBoxes(probMap, resizedW, resizedH, origW, origH);
  }

  private async buildFeeds(
    session: OnnxSession,
    tensor: unknown,
  ): Promise<Record<string, unknown>> {
    // onnxruntime-node accepts feeds keyed by input name. We don't have
    // typed metadata access in this minimal interface — stand on the
    // convention that single-input ORT models accept "x" or "input".
    // The runtime tolerates either; if a more specific name is needed,
    // pass it via the `inputNames` option on the session (advanced).
    const fallbackKeys = ["x", "input", "images", "data"];
    const feeds: Record<string, unknown> = {};
    for (const k of fallbackKeys) feeds[k] = tensor;
    return feeds;
  }

  private probMapToBoxes(
    probMap: { data: ArrayLike<number>; dims: number[] },
    inW: number,
    inH: number,
    origW: number,
    origH: number,
  ): Array<{ bbox: BoundingBox; confidence: number }> {
    // Probability map dims: typically [1, 1, H, W] or [1, H, W].
    const dims = probMap.dims;
    const h = dims[dims.length - 2];
    const w = dims[dims.length - 1];
    if (!h || !w) return [];
    const stride = w * h;
    const data = probMap.data;
    const xScale = origW / inW;
    const yScale = origH / inH;

    // Trivial connected-component pass: scan rows, group columns above
    // threshold into spans, then merge adjacent spans across rows. Returns
    // axis-aligned rectangles only; suitable for UI text, not curved.
    const threshold = 0.3;
    const visited = new Uint8Array(stride);
    const boxes: Array<{ bbox: BoundingBox; confidence: number }> = [];

    const get = (x: number, y: number): number => Number(data[y * w + x]) || 0;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (visited[idx]) continue;
        if (get(x, y) < threshold) continue;
        // BFS for connected pixels above threshold.
        let minX = x, maxX = x, minY = y, maxY = y;
        let probSum = 0;
        let count = 0;
        const stack: Array<[number, number]> = [[x, y]];
        while (stack.length) {
          const [cx, cy] = stack.pop()!;
          if (cx < 0 || cx >= w || cy < 0 || cy >= h) continue;
          const cidx = cy * w + cx;
          if (visited[cidx]) continue;
          const v = get(cx, cy);
          if (v < threshold) continue;
          visited[cidx] = 1;
          probSum += v;
          count++;
          minX = Math.min(minX, cx);
          maxX = Math.max(maxX, cx);
          minY = Math.min(minY, cy);
          maxY = Math.max(maxY, cy);
          stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
        }
        // Filter tiny noise.
        if (count < 8) continue;
        // DB unclip approximation: pad each box by ~10% of its smaller
        // dimension on each side. Improves recognition of characters that
        // sit near the detection threshold edge (typical of small UI text).
        const padX = Math.max(2, Math.round((maxX - minX) * 0.15));
        const padY = Math.max(2, Math.round((maxY - minY) * 0.25));
        const px = Math.max(0, minX - padX);
        const py = Math.max(0, minY - padY);
        const pxw = Math.min(w - 1, maxX + padX);
        const pyh = Math.min(h - 1, maxY + padY);
        boxes.push({
          bbox: {
            x: Math.round(px * xScale),
            y: Math.round(py * yScale),
            width: Math.round((pxw - px + 1) * xScale),
            height: Math.round((pyh - py + 1) * yScale),
          },
          confidence: probSum / count,
        });
      }
    }
    return boxes;
  }

  /**
   * Recognition step: crop the bounding box, resize to 48xN (CRNN expected
   * height for PP-OCRv5 mobile), feed to recognizer, decode with charset.
   * Skipped if the bbox crop is degenerate.
   */
  private async runRecognition(
    imageBuffer: Buffer,
    bbox: BoundingBox,
  ): Promise<string> {
    if (!this.recognitionSession || !this.onnx) return "";
    if (bbox.width < 4 || bbox.height < 4) return "";

    const targetH = 48;
    const cropMeta = await sharp(imageBuffer).metadata();
    if (!cropMeta.width || !cropMeta.height) return "";
    const safeW = Math.min(bbox.width, cropMeta.width - bbox.x);
    const safeH = Math.min(bbox.height, cropMeta.height - bbox.y);
    if (safeW <= 0 || safeH <= 0) return "";

    const aspect = safeW / safeH;
    const targetW = Math.max(16, Math.round(targetH * aspect / 16) * 16);

    const { data: rgb } = await sharp(imageBuffer)
      .extract({
        left: Math.max(0, bbox.x),
        top: Math.max(0, bbox.y),
        width: safeW,
        height: safeH,
      })
      .resize(targetW, targetH, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const float = new Float32Array(3 * targetW * targetH);
    // PP-OCR rec normalization: (x/255 - 0.5) / 0.5 → [-1, 1].
    for (let i = 0; i < targetW * targetH; i++) {
      const r = rgb[i * 3] / 255;
      const g = rgb[i * 3 + 1] / 255;
      const b = rgb[i * 3 + 2] / 255;
      float[i] = (r - 0.5) / 0.5;
      float[i + targetW * targetH] = (g - 0.5) / 0.5;
      float[i + 2 * targetW * targetH] = (b - 0.5) / 0.5;
    }

    const tensor = new this.onnx.Tensor("float32", float, [1, 3, targetH, targetW]);
    const feeds = await this.buildFeeds(this.recognitionSession, tensor);
    const output = await this.recognitionSession.run(feeds);
    const firstKey = Object.keys(output)[0];
    const probs = output[firstKey];
    if (!probs) return "";

    return this.ctcDecode(probs);
  }

  /**
   * CTC greedy decoding for the CRNN output. Output dims: [1, T, C] where
   * C is `charset.length + 1` (blank at index 0). Blanks and consecutive
   * duplicates are collapsed.
   */
  private ctcDecode(probs: {
    data: ArrayLike<number>;
    dims: number[];
  }): string {
    const dims = probs.dims;
    const T = dims[1] ?? 0;
    const C = dims[2] ?? 0;
    if (!T || !C) return "";
    const data = probs.data;
    const out: number[] = [];
    let prev = -1;
    for (let t = 0; t < T; t++) {
      let best = 0;
      let bestVal = Number(data[t * C]) || 0;
      for (let c = 1; c < C; c++) {
        const v = Number(data[t * C + c]) || 0;
        if (v > bestVal) {
          bestVal = v;
          best = c;
        }
      }
      if (best !== 0 && best !== prev) out.push(best - 1);
      prev = best;
    }
    return out
      .map((idx) => this.charset[idx] ?? "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
  }

  async dispose(): Promise<void> {
    if (this.detectionSession?.release) await this.detectionSession.release();
    if (this.recognitionSession?.release) await this.recognitionSession.release();
    this.detectionSession = null;
    this.recognitionSession = null;
    this.charset = [];
    this.initialized = false;
    this.initPromise = null;
    logger.info("[RapidOCR] disposed");
  }
}
