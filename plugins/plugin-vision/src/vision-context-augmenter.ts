/**
 * Vision-context augmenter (issue #9105).
 *
 * Runs the token-free pre-vision detectors plugin-vision owns — OCR
 * (tesseract / native OS engines), object detection (YOLO), face detection —
 * over an image and folds their results into the describe prompt as structured
 * text. The on-device Gemma-4 VL model then grounds its description in real
 * extracted signals (small text it would otherwise misread, object identity,
 * presence of people) instead of guessing.
 *
 * This is the *provider* half of the seam. plugin-local-inference owns the
 * registry (`registerVisionContextAugmenter`); this class is registered into it
 * at boot via a best-effort dynamic import (see `index.ts`), mirroring the
 * coord-OCR bridge into plugin-computeruse. Every detector is optional and
 * best-effort: an unavailable or failing detector contributes nothing rather
 * than failing the describe.
 */

import { Buffer } from "node:buffer";
import { logger } from "@elizaos/core";
import {
  getOcrWithCoordsService,
  type OcrWithCoordsService,
} from "./ocr-with-coords.js";

/** Raw signals extracted from an image, joined into prompt-ready strings. */
export interface FusedVisionSignals {
  ocrText?: string;
  objects?: string;
  faces?: string;
}

/** Image wrapper accepted by the augmenter — matches the handler's request shape. */
export type AugmenterImageInput =
  | { kind: "bytes"; bytes: Uint8Array; mimeType?: string }
  | { kind: "base64"; base64: string; mimeType?: string }
  | { kind: "dataUrl"; dataUrl: string }
  | { kind: "url"; url: string; mimeType?: string };

export interface VisionAugmentInput {
  image: AugmenterImageInput;
  basePrompt?: string;
}

export interface VisionAugmentOutput {
  prompt: string;
  fused: FusedVisionSignals;
}

/**
 * Injectable detector hooks. OCR defaults to the registered coord-OCR service;
 * object/face detection are wired only when their native artifacts are present.
 * Exposed so tests can drive the fusion with deterministic fakes (no native
 * libs, no real tesseract).
 */
export interface VisionAugmenterDetectors {
  getOcr?: () => OcrWithCoordsService | null;
  detectObjects?: (
    imageBytes: Buffer,
  ) => Promise<ReadonlyArray<{ type: string; confidence: number }>>;
  detectFaces?: (imageBytes: Buffer) => Promise<number>;
}

const DEFAULT_DESCRIBE_PROMPT = "Describe what is in this image.";
const MAX_OBJECTS = 12;
const MAX_OCR_BLOCKS = 24;

/**
 * Keep only OCR fragments that carry real signal. Tesseract run over a natural
 * photo (vs a clean document) emits per-glyph noise — `|`, `=`, `—`, stray
 * single letters — that would pollute the prompt and waste tokens. Require at
 * least two alphanumeric characters so genuine words/labels survive and noise
 * is dropped. Pure — exported for tests.
 */
export function isMeaningfulOcrText(text: string): boolean {
  return (text.match(/[A-Za-z0-9]/g)?.length ?? 0) >= 2;
}

/**
 * Sentinel that marks an already-augmented prompt. Lets the augmenter stay
 * idempotent — if a prompt that already carries a fused-context block is fed
 * back in (re-describe, retry), we skip rather than stacking a second block.
 */
const FUSED_CONTEXT_MARKER = "Detected context — pre-extracted from this image";

export class FusedVisionContextAugmenter {
  readonly name = "vision-fused-context";

  constructor(private readonly deps: VisionAugmenterDetectors = {}) {}

  async augmentImagePrompt(
    input: VisionAugmentInput,
  ): Promise<VisionAugmentOutput | null> {
    if (input.basePrompt?.includes(FUSED_CONTEXT_MARKER)) return null;
    const bytes = resolveImageBytes(input.image);
    if (!bytes || bytes.byteLength === 0) return null;

    const fused: FusedVisionSignals = {};

    const ocr = (this.deps.getOcr ?? getOcrWithCoordsService)();
    if (ocr) {
      try {
        const res = await ocr.describe({
          displayId: "vision-describe",
          sourceX: 0,
          sourceY: 0,
          pngBytes: new Uint8Array(bytes),
        });
        const lines = res.blocks
          .map((b) => b.text.trim())
          .filter(isMeaningfulOcrText)
          .slice(0, MAX_OCR_BLOCKS);
        if (lines.length > 0) {
          fused.ocrText = lines.map((t) => `"${t}"`).join(", ");
        }
      } catch (err) {
        logger.debug(`[vision-augment] OCR skipped: ${messageOf(err)}`);
      }
    }

    if (this.deps.detectObjects) {
      try {
        const objs = await this.deps.detectObjects(bytes);
        if (objs.length > 0) {
          fused.objects = objs
            .slice(0, MAX_OBJECTS)
            .map((o) => `${o.type} (${o.confidence.toFixed(2)})`)
            .join(", ");
        }
      } catch (err) {
        logger.debug(
          `[vision-augment] object detection skipped: ${messageOf(err)}`,
        );
      }
    }

    if (this.deps.detectFaces) {
      try {
        const n = await this.deps.detectFaces(bytes);
        if (n > 0) fused.faces = `${n} ${n === 1 ? "face" : "faces"}`;
      } catch (err) {
        logger.debug(
          `[vision-augment] face detection skipped: ${messageOf(err)}`,
        );
      }
    }

    if (!fused.ocrText && !fused.objects && !fused.faces) return null;
    return {
      prompt: buildAugmentedPrompt(input.basePrompt, fused),
      fused,
    };
  }
}

/**
 * Compose the final prompt: the caller's prompt (or a default) followed by a
 * clearly-delimited block of detected signals. Pure — exported for tests so the
 * prompt contract has a single source of truth.
 */
export function buildAugmentedPrompt(
  basePrompt: string | undefined,
  fused: FusedVisionSignals,
): string {
  const base = basePrompt?.trim() || DEFAULT_DESCRIBE_PROMPT;
  const lines: string[] = [];
  if (fused.ocrText) lines.push(`Text (OCR): ${fused.ocrText}`);
  if (fused.objects) lines.push(`Objects: ${fused.objects}`);
  if (fused.faces) lines.push(`Faces: ${fused.faces}`);
  if (lines.length === 0) return base;
  return [
    base,
    "",
    `${FUSED_CONTEXT_MARKER} to ground your answer. Use these signals; correct them only if the image clearly contradicts them.`,
    ...lines.map((l) => `- ${l}`),
  ].join("\n");
}

/**
 * Resolve an image wrapper to encoded image bytes. Handles only the inline
 * shapes (bytes / base64 / data URL). `url` inputs of EVERY form —
 * `http(s)://`, `file://`, and bare filesystem paths — return `null`: the
 * augmenter performs no file or network I/O. Remote URLs are fetched by the
 * describe backend through the SSRF guard, and reading a `file://`/bare-path
 * off an agent-supplied describe URL would be a local-file-read primitive (the
 * canonical resolver in `plugin-local-inference/.../hash.ts` refuses `url`
 * inputs for the same reason). No bytes → no OCR augmentation; the backend
 * still describes the raw image via its own resolution.
 */
function resolveImageBytes(image: AugmenterImageInput): Buffer | null {
  switch (image.kind) {
    case "bytes":
      return Buffer.from(image.bytes);
    case "base64":
      return Buffer.from(image.base64, "base64");
    case "dataUrl": {
      const comma = image.dataUrl.indexOf(",");
      if (comma < 0) return null;
      return Buffer.from(image.dataUrl.slice(comma + 1), "base64");
    }
    case "url":
      return null;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The production augmenter: OCR via the registered coord-OCR service, plus YOLO
 * object detection and BlazeFace face detection wired lazily and gated on their
 * `isAvailable()` probe. Until those native artifacts ship, the gate is false
 * and they contribute nothing — OCR alone augments the prompt. When the
 * artifacts land the same fusion point activates them with no further wiring.
 */
export function createDefaultVisionAugmenter(): FusedVisionContextAugmenter {
  return new FusedVisionContextAugmenter({
    detectObjects: lazyObjectDetector(),
    detectFaces: lazyFaceDetector(),
  });
}

function lazyObjectDetector(): (
  bytes: Buffer,
) => Promise<ReadonlyArray<{ type: string; confidence: number }>> {
  let detector: import("./yolo-detector.js").YOLODetector | null = null;
  let resolved = false;
  return async (bytes) => {
    if (!resolved) {
      resolved = true;
      const { YOLODetector } = await import("./yolo-detector.js");
      if (await YOLODetector.isAvailable()) detector = new YOLODetector();
    }
    if (!detector) return [];
    const objs = await detector.detect(bytes);
    return objs.map((o) => ({ type: o.type, confidence: o.confidence }));
  };
}

function lazyFaceDetector(): (bytes: Buffer) => Promise<number> {
  let detector: import("./face-detector-ggml.js").BlazeFaceGgmlDetector | null =
    null;
  let resolved = false;
  return async (bytes) => {
    if (!resolved) {
      resolved = true;
      const { BlazeFaceGgmlDetector } = await import("./face-detector-ggml.js");
      if (await BlazeFaceGgmlDetector.isAvailable()) {
        detector = new BlazeFaceGgmlDetector();
      }
    }
    if (!detector) return 0;
    const faces = await detector.detect(bytes);
    return faces.length;
  };
}
