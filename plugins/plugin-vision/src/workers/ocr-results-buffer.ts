/**
 * Shared layout and codec for the OCR results SharedArrayBuffer exchanged
 * between the OCR worker (writer, `ocr-worker.ts`) and the main-thread
 * `VisionWorkerManager` (reader). Centralizing the layout keeps the writer's
 * copied-byte count and the reader's decoded-byte count derived from a single
 * capacity, so a dense frame's OCR JSON can no longer be silently truncated to
 * an arbitrary 64KB cap while the header advertises the full length. The header
 * length written here always equals the payload bytes physically committed to
 * the buffer, and the reader treats any length beyond capacity as an explicit
 * error rather than a truncated parse.
 */

import { ElizaError } from "@elizaos/core";
import type { OCRResult } from "../types";

/** Total size of the OCR results SharedArrayBuffer. */
export const OCR_RESULTS_BUFFER_SIZE = 5 * 1024 * 1024;

/** Reserved header region preceding the per-frame metadata. */
export const OCR_RESULTS_HEADER_SIZE = 16;

/** Per-frame metadata written after the reserved header: uint32 length, uint32 frameId, float64 timestamp. */
export const OCR_RESULTS_METADATA_SIZE = 16;

/** Byte offset at which the serialized JSON payload begins. */
export const OCR_RESULTS_DATA_OFFSET =
  OCR_RESULTS_HEADER_SIZE + OCR_RESULTS_METADATA_SIZE;

/**
 * Maximum number of payload bytes the buffer can hold. This is the single cap
 * used by both the writer and the reader; it replaces the former hardcoded
 * 65536 that was far smaller than the buffer and caused mid-JSON truncation.
 */
export const OCR_RESULTS_PAYLOAD_CAPACITY =
  OCR_RESULTS_BUFFER_SIZE - OCR_RESULTS_DATA_OFFSET;

/** Serialized shape written to the buffer. Extends the OCR result with frame metadata. */
export interface SerializedOcrResult {
  frameId: number;
  timestamp: number;
  fullText: string;
  blocks: OCRResult["blocks"];
  regions: number;
  /** True when the payload exceeded buffer capacity and lower-value blocks were dropped to fit. */
  truncated: boolean;
}

function encodeCombined(combined: SerializedOcrResult): Buffer {
  return Buffer.from(JSON.stringify(combined), "utf-8");
}

/**
 * Serialize combined OCR results into a UTF-8 JSON payload that fits within
 * `capacity`. The common case (a payload under capacity) is written whole. Only
 * when a frame's JSON genuinely exceeds the multi-megabyte buffer are the
 * lowest-value fields (per-block bounding boxes) dropped, preserving `fullText`
 * and flagging `truncated: true`. The returned bytes are always valid JSON and
 * never longer than `capacity`, so the caller can commit every byte and record
 * a header length equal to what it wrote.
 */
export function encodeOcrResultWithinCapacity(
  results: OCRResult[],
  frameId: number,
  timestamp: number,
  capacity: number = OCR_RESULTS_PAYLOAD_CAPACITY,
): { bytes: Buffer; truncated: boolean } {
  const fullText = results.map((r) => r.fullText).join("\n");
  const blocks = results.flatMap((r) => r.blocks);
  const regions = results.length;

  const build = (
    keptBlocks: OCRResult["blocks"],
    text: string,
    truncated: boolean,
  ): Buffer =>
    encodeCombined({
      frameId,
      timestamp,
      fullText: text,
      blocks: keptBlocks,
      regions,
      truncated,
    });

  const whole = build(blocks, fullText, false);
  if (whole.length <= capacity) {
    return { bytes: whole, truncated: false };
  }

  // The frame's JSON exceeds the buffer. Keep as many blocks as fit while
  // preserving full text, marking the payload truncated so downstream readers
  // know bounding-box detail was dropped at this hard resource boundary.
  let lo = 0;
  let hi = blocks.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = build(blocks.slice(0, mid), fullText, true);
    if (candidate.length <= capacity) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  let bytes = build(blocks.slice(0, best), fullText, true);
  if (bytes.length <= capacity) {
    return { bytes, truncated: true };
  }

  // Even zero blocks with the full text overflows: the recognized text alone
  // exceeds a multi-megabyte buffer. Shrink the text as a final fallback so the
  // buffer still holds valid, explicitly-truncated JSON rather than nothing.
  let text = fullText;
  while (text.length > 0) {
    text = text.slice(0, Math.floor(text.length / 2));
    bytes = build([], text, true);
    if (bytes.length <= capacity) {
      return { bytes, truncated: true };
    }
  }
  return { bytes: build([], "", true), truncated: true };
}

/**
 * Write combined OCR results into the results buffer via `view`. Returns the
 * number of payload bytes committed (always equal to the header length written)
 * and whether the payload was truncated to fit capacity.
 */
export function writeOcrResultToBuffer(
  view: DataView,
  results: OCRResult[],
  frameId: number,
  timestamp: number = Date.now(),
  capacity: number = OCR_RESULTS_PAYLOAD_CAPACITY,
): { length: number; truncated: boolean } {
  const { bytes, truncated } = encodeOcrResultWithinCapacity(
    results,
    frameId,
    timestamp,
    capacity,
  );

  const offset = OCR_RESULTS_HEADER_SIZE;
  view.setUint32(offset, bytes.length, true);
  view.setUint32(offset + 4, frameId, true);
  view.setFloat64(offset + 8, timestamp, true);

  for (let i = 0; i < bytes.length; i++) {
    view.setUint8(OCR_RESULTS_DATA_OFFSET + i, bytes[i]);
  }

  return { length: bytes.length, truncated };
}

/**
 * Read a combined OCR result from the results buffer via `view`. Returns `null`
 * when no result has been written (length 0). Throws an {@link ElizaError} when
 * the header length exceeds buffer capacity, which signals a corrupt or
 * inconsistent write rather than a value the reader may safely parse.
 */
export function readOcrResultFromBuffer(
  view: DataView,
  capacity: number = OCR_RESULTS_PAYLOAD_CAPACITY,
): SerializedOcrResult | null {
  const offset = OCR_RESULTS_HEADER_SIZE;
  const length = view.getUint32(offset, true);
  if (length === 0) {
    return null;
  }
  if (length > capacity) {
    throw new ElizaError("OCR results header length exceeds buffer capacity", {
      code: "VISION_OCR_RESULT_LENGTH_EXCEEDS_CAPACITY",
      context: { length, capacity },
      severity: "fatal",
    });
  }

  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = view.getUint8(OCR_RESULTS_DATA_OFFSET + i);
  }

  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json) as SerializedOcrResult;
}
