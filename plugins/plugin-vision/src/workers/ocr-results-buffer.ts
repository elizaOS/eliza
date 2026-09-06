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
 *
 * Overflow is represented, never hidden. The recognized text (`fullText`) is
 * model-facing perception, so it is preserved whole; when the whole payload
 * exceeds capacity only the trailing bounding-box blocks are dropped (in
 * reading order, latest first) and the omitted count is reported. When the
 * recognized text alone cannot fit, the codec refuses to emit a text prefix and
 * instead writes an explicit `textOverflow` marker the reader turns into an
 * unavailable/size-error state, so a partial value is never presented as
 * complete perception.
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
  /** Number of bounding-box blocks recognized before any were dropped to fit. */
  totalBlocks: number;
  /**
   * Number of trailing bounding-box blocks dropped to fit capacity; 0 when the
   * whole payload fit. When positive, `fullText` is still complete — only
   * per-block box metadata was omitted.
   */
  omittedBlocks: number;
  /** True when trailing blocks were dropped to fit; `fullText` stays complete. */
  truncated: boolean;
  /**
   * True only when the recognized text alone exceeds capacity, so no complete
   * value can be transferred. `fullText` and `blocks` are empty in this case;
   * the reader must surface an explicit size error, never a text prefix.
   */
  textOverflow: boolean;
  /** UTF-8 byte length of the text that could not fit, when `textOverflow`. */
  overflowTextBytes: number;
}

function encodeCombined(combined: SerializedOcrResult): Buffer {
  return Buffer.from(JSON.stringify(combined), "utf-8");
}

/** Metadata describing what, if anything, was dropped to fit the buffer. */
export interface OcrEncodeOutcome {
  bytes: Buffer;
  /** True when trailing blocks were dropped but `fullText` remains complete. */
  truncated: boolean;
  totalBlocks: number;
  omittedBlocks: number;
  /** True when the recognized text alone overflowed; no partial text is emitted. */
  textOverflow: boolean;
  overflowTextBytes: number;
}

/**
 * Serialize combined OCR results into a UTF-8 JSON payload that fits within
 * `capacity`. The common case (a payload under capacity) is written whole.
 *
 * When the whole payload exceeds capacity, the recognized text is preserved in
 * full and only the trailing bounding-box blocks are dropped, in document
 * reading order (the leading blocks are kept, later blocks omitted). The number
 * of omitted blocks is reported so the consumer can surface a partial state.
 *
 * When even zero blocks plus the recognized text exceeds capacity, no complete
 * text value can be transferred. The codec refuses to emit a text prefix and
 * instead returns a small `textOverflow` marker payload (empty text/blocks)
 * carrying the original text byte length, so the reader can raise an explicit
 * unavailable/size-error state rather than present a prefix as complete.
 *
 * The returned bytes are always valid JSON no longer than `capacity`, so the
 * caller can commit every byte and record a header length equal to what it
 * wrote.
 */
export function encodeOcrResultWithinCapacity(
  results: OCRResult[],
  frameId: number,
  timestamp: number,
  capacity: number = OCR_RESULTS_PAYLOAD_CAPACITY,
): OcrEncodeOutcome {
  const fullText = results.map((r) => r.fullText).join("\n");
  const blocks = results.flatMap((r) => r.blocks);
  const regions = results.length;
  const totalBlocks = blocks.length;

  const build = (
    keptBlocks: OCRResult["blocks"],
    omittedBlocks: number,
    truncated: boolean,
  ): Buffer =>
    encodeCombined({
      frameId,
      timestamp,
      fullText,
      blocks: keptBlocks,
      regions,
      totalBlocks,
      omittedBlocks,
      truncated,
      textOverflow: false,
      overflowTextBytes: 0,
    });

  const whole = build(blocks, 0, false);
  if (whole.length <= capacity) {
    return {
      bytes: whole,
      truncated: false,
      totalBlocks,
      omittedBlocks: 0,
      textOverflow: false,
      overflowTextBytes: 0,
    };
  }

  // The frame's JSON exceeds the buffer. Preserve the complete recognized text
  // and retain the leading blocks in reading order, dropping trailing blocks
  // until the payload fits. Value ordering is document reading order: earlier
  // blocks are kept, later ones omitted, and the omitted count is reported so
  // the consumer can show the result as partial.
  let lo = 0;
  let hi = blocks.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = build(blocks.slice(0, mid), blocks.length - mid, true);
    if (candidate.length <= capacity) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const omittedBlocks = blocks.length - best;
  const kept = build(blocks.slice(0, best), omittedBlocks, true);
  if (kept.length <= capacity) {
    return {
      bytes: kept,
      truncated: true,
      totalBlocks,
      omittedBlocks,
      textOverflow: false,
      overflowTextBytes: 0,
    };
  }

  // Even zero blocks with the complete text overflows: the recognized text
  // alone exceeds the buffer. We must not present a text prefix as complete, so
  // emit an explicit size-error marker (empty text/blocks) carrying the
  // original text byte length. The reader turns this into an unavailable state.
  const overflowTextBytes = Buffer.byteLength(fullText, "utf-8");
  const marker = encodeCombined({
    frameId,
    timestamp,
    fullText: "",
    blocks: [],
    regions,
    totalBlocks,
    omittedBlocks: totalBlocks,
    truncated: true,
    textOverflow: true,
    overflowTextBytes,
  });
  return {
    bytes: marker,
    truncated: true,
    totalBlocks,
    omittedBlocks: totalBlocks,
    textOverflow: true,
    overflowTextBytes,
  };
}

/** Result of committing an OCR payload to the buffer. */
export interface OcrWriteOutcome {
  /** Payload bytes committed; always equal to the header length written. */
  length: number;
  truncated: boolean;
  totalBlocks: number;
  omittedBlocks: number;
  textOverflow: boolean;
  overflowTextBytes: number;
}

/**
 * Write combined OCR results into the results buffer via `view`. Returns the
 * number of payload bytes committed (always equal to the header length written)
 * and what, if anything, was dropped to fit capacity.
 */
export function writeOcrResultToBuffer(
  view: DataView,
  results: OCRResult[],
  frameId: number,
  timestamp: number = Date.now(),
  capacity: number = OCR_RESULTS_PAYLOAD_CAPACITY,
): OcrWriteOutcome {
  const outcome = encodeOcrResultWithinCapacity(
    results,
    frameId,
    timestamp,
    capacity,
  );
  const { bytes } = outcome;

  const offset = OCR_RESULTS_HEADER_SIZE;
  view.setUint32(offset, bytes.length, true);
  view.setUint32(offset + 4, frameId, true);
  view.setFloat64(offset + 8, timestamp, true);

  for (let i = 0; i < bytes.length; i++) {
    view.setUint8(OCR_RESULTS_DATA_OFFSET + i, bytes[i]);
  }

  return {
    length: bytes.length,
    truncated: outcome.truncated,
    totalBlocks: outcome.totalBlocks,
    omittedBlocks: outcome.omittedBlocks,
    textOverflow: outcome.textOverflow,
    overflowTextBytes: outcome.overflowTextBytes,
  };
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
