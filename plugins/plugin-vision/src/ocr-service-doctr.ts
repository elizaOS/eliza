// doctr-based OCR backend — ggml runtime via `native/doctr.cpp/`.
//
// Replaces the previous PP-OCRv5 / onnxruntime-node path. Two-stage pipeline:
//   1. Detection (db_mobilenet_v3_large + DBNet head) — produces a probability
//      map at H/4 × W/4.
//   2. Contour → bbox post-processing (this file).
//   3. Recognition (crnn_mobilenet_v3_small + CTC) — per-crop logits.
//   4. CTC greedy decode (this file).
//
// The C++ side runs only the forward passes. Post-processing is pure TS to
// keep the native surface minimal and to share the same decode logic with
// any future on-device OCR (Apple Vision returns text directly so its
// recognition path skips steps 2-4).
//
// **No fallback** — if doctr.cpp + GGUFs aren't available the service throws
// a clear error and the chain in `ocr-service.ts` falls through to the next
// backend (apple-vision on darwin) or surfaces the error to the caller.

import { logger } from "@elizaos/core";
import sharp from "sharp";
import {
  defaultDetWeightsPath,
  defaultRecWeightsPath,
  isDoctrReady,
  loadDoctrBindings,
} from "./native/doctr-ffi";
import type { BoundingBox, OCRResult } from "./types";

export interface DoctrOCRConfig {
  /** GGUF detection weights path. */
  detPath?: string;
  /** GGUF recognition weights path. */
  recPath?: string;
  /** Detection input resolution (square). Default 1024. */
  inputSize?: number;
  /** Probability threshold for the DBNet output. */
  probThreshold?: number;
  /** Minimum connected-component pixel count for a detection. */
  minComponentSize?: number;
}

/**
 * Detect platforms where Apple Vision is the better OCR choice.
 *
 * macOS Sonoma+ and iOS expose VNRecognizeTextRequest which is faster and
 * higher-quality than any community OCR for Latin scripts. The integration
 * lives in `plugin-computeruse/mobile`; we just refuse to claim availability
 * so the higher-priority Apple Vision backend wins on darwin.
 */
export function shouldPreferAppleVision(): boolean {
  return (
    process.platform === "darwin" &&
    process.env.ELIZA_DISABLE_APPLE_VISION !== "1"
  );
}

export class DoctrOCRService {
  private readonly cfg: Required<
    Pick<DoctrOCRConfig, "inputSize" | "probThreshold" | "minComponentSize">
  > &
    DoctrOCRConfig;
  private initPromise: Promise<void> | null = null;
  private initialized = false;
  private charset: string[] = [];

  constructor(config: DoctrOCRConfig = {}) {
    this.cfg = {
      detPath: config.detPath ?? defaultDetWeightsPath(),
      recPath: config.recPath ?? defaultRecWeightsPath(),
      inputSize: config.inputSize ?? 1024,
      probThreshold: config.probThreshold ?? 0.3,
      minComponentSize: config.minComponentSize ?? 8,
    };
  }

  /**
   * Best-effort availability check. Confirms the native lib loads and the
   * GGUF files are on disk. Does NOT prove the ggml forward pass works —
   * that's discovered on the first `extractText` call.
   */
  static async isAvailable(opts?: {
    detPath?: string;
    recPath?: string;
  }): Promise<boolean> {
    const { ready } = await isDoctrReady(opts);
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
    const { ready, reason } = await isDoctrReady({
      detPath: this.cfg.detPath,
      recPath: this.cfg.recPath,
    });
    if (!ready) {
      throw new Error(
        `[DoctrOCR] migration in progress; GGUF not ready (${reason ?? "unknown"}). ` +
          `Build the native lib at plugins/plugin-vision/native/doctr.cpp and run ` +
          `scripts/convert.py to produce doctr-det.gguf + doctr-rec.gguf.`,
      );
    }
    const bindings = await loadDoctrBindings();
    if (!bindings) {
      throw new Error(
        "[DoctrOCR] native bindings failed to load after readiness check passed",
      );
    }
    const charsetText = await bindings.charset(this.cfg.recPath!);
    this.charset = charsetText.split(/\r?\n/).filter(Boolean);
    this.initialized = true;
    logger.info(
      `[DoctrOCR] initialized (det=${this.cfg.detPath}, rec=${this.cfg.recPath}, charset=${this.charset.length})`,
    );
  }

  async extractText(imageBuffer: Buffer): Promise<OCRResult> {
    if (!this.initialized) await this.initialize();
    const bindings = await loadDoctrBindings();
    if (!bindings) {
      throw new Error("[DoctrOCR] native bindings unavailable at extract time");
    }

    const meta = await sharp(imageBuffer).metadata();
    const origW = meta.width ?? 0;
    const origH = meta.height ?? 0;
    if (!origW || !origH) {
      return { text: "", blocks: [], fullText: "" };
    }

    const inSize = this.cfg.inputSize;
    const { data: rgb } = await sharp(imageBuffer)
      .resize(inSize, inSize, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const detInput = this.toCHWFloat32(rgb, inSize, inSize);
    const { probMap, h: probH, w: probW } = await bindings.detect(
      this.cfg.detPath!,
      detInput,
      inSize,
      inSize,
    );

    const xScale = origW / inSize;
    const yScale = origH / inSize;
    const regions = this.probMapToBoxes(probMap, probW, probH, xScale, yScale);

    const blocks: OCRResult["blocks"] = [];
    for (const region of regions) {
      const recText = await this.recognizeCrop(
        bindings,
        imageBuffer,
        region.bbox,
      );
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

  private toCHWFloat32(
    rgb: Buffer,
    w: number,
    h: number,
  ): Float32Array {
    const float = new Float32Array(3 * w * h);
    const stride = w * h;
    for (let i = 0; i < stride; i++) {
      float[i] = rgb[i * 3] / 255;
      float[i + stride] = rgb[i * 3 + 1] / 255;
      float[i + 2 * stride] = rgb[i * 3 + 2] / 255;
    }
    return float;
  }

  /**
   * DBNet contouring: scan the probability map, group above-threshold pixels
   * into connected components, return axis-aligned bboxes in original image
   * coordinates.
   *
   * This is the same algorithm as the previous PP-OCRv5 path — it's a
   * standard DBNet post-process and works for both detection backbones.
   */
  private probMapToBoxes(
    probMap: Float32Array,
    w: number,
    h: number,
    xScale: number,
    yScale: number,
  ): Array<{ bbox: BoundingBox; confidence: number }> {
    if (!h || !w) return [];
    const threshold = this.cfg.probThreshold;
    const minSize = this.cfg.minComponentSize;
    const visited = new Uint8Array(w * h);
    const boxes: Array<{ bbox: BoundingBox; confidence: number }> = [];

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (visited[idx]) continue;
        if (probMap[idx] < threshold) continue;
        let minX = x;
        let maxX = x;
        let minY = y;
        let maxY = y;
        let probSum = 0;
        let count = 0;
        const stack: Array<[number, number]> = [[x, y]];
        while (stack.length) {
          const [cx, cy] = stack.pop()!;
          if (cx < 0 || cx >= w || cy < 0 || cy >= h) continue;
          const cidx = cy * w + cx;
          if (visited[cidx]) continue;
          const v = probMap[cidx];
          if (v < threshold) continue;
          visited[cidx] = 1;
          probSum += v;
          count++;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
          stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
        }
        if (count < minSize) continue;
        // DBNet unclip approximation: pad bbox before mapping back.
        const padX = Math.max(2, Math.round((maxX - minX) * 0.15));
        const padY = Math.max(2, Math.round((maxY - minY) * 0.25));
        const px = Math.max(0, minX - padX);
        const py = Math.max(0, minY - padY);
        const pxw = Math.min(w - 1, maxX + padX);
        const pyh = Math.min(h - 1, maxY + padY);
        // The probability map is at det-input resolution / 4. We mapped that
        // implicitly: probMap dims are already passed (H/4, W/4); we scale
        // through that into original-image coords via xScale*4 / yScale*4.
        const xs = xScale * 4;
        const ys = yScale * 4;
        boxes.push({
          bbox: {
            x: Math.round(px * xs),
            y: Math.round(py * ys),
            width: Math.round((pxw - px + 1) * xs),
            height: Math.round((pyh - py + 1) * ys),
          },
          confidence: probSum / count,
        });
      }
    }
    return boxes;
  }

  /**
   * Recognition step: crop the bbox, resize to 32xN, run through the CRNN
   * recognizer, CTC-decode the output.
   */
  private async recognizeCrop(
    bindings: Awaited<ReturnType<typeof loadDoctrBindings>>,
    imageBuffer: Buffer,
    bbox: BoundingBox,
  ): Promise<string> {
    if (!bindings) return "";
    if (bbox.width < 4 || bbox.height < 4) return "";
    const targetH = 32;
    const cropMeta = await sharp(imageBuffer).metadata();
    if (!cropMeta.width || !cropMeta.height) return "";
    const safeW = Math.min(bbox.width, cropMeta.width - bbox.x);
    const safeH = Math.min(bbox.height, cropMeta.height - bbox.y);
    if (safeW <= 0 || safeH <= 0) return "";

    const aspect = safeW / safeH;
    const targetW = Math.max(16, Math.round((targetH * aspect) / 8) * 8);

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

    const recInput = this.toCHWFloat32(rgb, targetW, targetH);
    const { logits, T, C } = await bindings.recognize(
      this.cfg.recPath!,
      recInput,
      targetH,
      targetW,
    );
    return this.ctcDecode(logits, T, C);
  }

  /** CTC greedy decoding. Blank index = 0. */
  private ctcDecode(logits: Float32Array, T: number, C: number): string {
    if (!T || !C) return "";
    const out: number[] = [];
    let prev = -1;
    for (let t = 0; t < T; t++) {
      let best = 0;
      let bestVal = logits[t * C];
      for (let c = 1; c < C; c++) {
        const v = logits[t * C + c];
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
    const bindings = await loadDoctrBindings();
    if (bindings) await bindings.dispose();
    this.initialized = false;
    this.initPromise = null;
    logger.info("[DoctrOCR] disposed");
  }
}
