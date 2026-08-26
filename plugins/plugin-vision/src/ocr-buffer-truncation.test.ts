/**
 * Regression tests for the OCR results SharedArrayBuffer round-trip
 * (issue #29076). These exercise the real shared writer/reader codec in
 * `workers/ocr-results-buffer.ts` and the real, reachable
 * `VisionWorkerManager.readOCRResult` reader — no worker threads, GPU, or
 * display required. Before the fix, a dense frame's OCR JSON larger than the
 * former hardcoded 64KB cap was truncated mid-token, so `JSON.parse` threw and
 * the entire OCR frame was silently discarded even though it fit comfortably in
 * the 5MB buffer. The suite proves such payloads now round-trip intact and that
 * the writer never advertises a header length larger than the bytes it wrote.
 */

import { describe, expect, it } from "vitest";
import type { OCRResult } from "./types";
import { VisionWorkerManager } from "./vision-worker-manager";
import {
  encodeOcrResultWithinCapacity,
  OCR_RESULTS_BUFFER_SIZE,
  OCR_RESULTS_DATA_OFFSET,
  OCR_RESULTS_HEADER_SIZE,
  OCR_RESULTS_PAYLOAD_CAPACITY,
  readOcrResultFromBuffer,
  writeOcrResultToBuffer,
} from "./workers/ocr-results-buffer";

function makeBlock(i: number): OCRResult["blocks"][number] {
  return {
    text: `block-${i}-lorem-ipsum-dolor-sit-amet-consectetur`,
    bbox: { x: i * 3, y: i * 5, width: 120 + i, height: 24 + (i % 7) },
    confidence: 0.9 + (i % 10) / 1000,
  };
}

function makeDenseResult(blockCount: number): OCRResult {
  const blocks = Array.from({ length: blockCount }, (_, i) => makeBlock(i));
  return {
    text: blocks.map((b) => b.text).join(" "),
    fullText: blocks.map((b) => b.text).join("\n"),
    blocks,
  };
}

/** The header length the writer physically committed for the last write. */
function headerLength(view: DataView): number {
  return view.getUint32(OCR_RESULTS_HEADER_SIZE, true);
}

describe("OCR results buffer round-trip (issue #29076)", () => {
  it("round-trips a small OCR result through the real manager reader", () => {
    const manager = new VisionWorkerManager({ ocrEnabled: true } as never);
    const view = Reflect.get(manager, "ocrResultsView") as DataView;

    const written = writeOcrResultToBuffer(
      view,
      [{ text: "hello world", fullText: "hello world", blocks: [] }],
      1,
    );
    expect(written.truncated).toBe(false);

    const read = Reflect.get(manager, "readOCRResult").call(
      manager,
    ) as OCRResult | null;
    expect(read).not.toBeNull();
    expect(read?.fullText).toBe("hello world");
  });

  it("round-trips a ~200KB dense OCR result intact (was silently dropped before the fix)", () => {
    const manager = new VisionWorkerManager({ ocrEnabled: true } as never);
    const view = Reflect.get(manager, "ocrResultsView") as DataView;

    const dense = makeDenseResult(1200);
    const { bytes } = encodeOcrResultWithinCapacity([dense], 7, Date.now());
    // Confirm this payload is exactly the regime that used to break: larger
    // than the old 64KB cap, far smaller than the 5MB buffer.
    expect(bytes.length).toBeGreaterThan(65536);
    expect(bytes.length).toBeGreaterThan(150 * 1024);
    expect(bytes.length).toBeLessThan(OCR_RESULTS_PAYLOAD_CAPACITY);

    const written = writeOcrResultToBuffer(view, [dense], 7);
    expect(written.truncated).toBe(false);

    const read = Reflect.get(manager, "readOCRResult").call(
      manager,
    ) as OCRResult | null;
    expect(read).not.toBeNull();
    expect(read?.blocks.length).toBe(dense.blocks.length);
    expect(read?.fullText).toBe(dense.fullText);
    expect(read?.blocks[0]).toEqual(dense.blocks[0]);
    expect(read?.blocks[dense.blocks.length - 1]).toEqual(
      dense.blocks[dense.blocks.length - 1],
    );
  });

  it("never records a header length greater than the bytes physically written", () => {
    const view = new DataView(new ArrayBuffer(OCR_RESULTS_BUFFER_SIZE));

    for (const blockCount of [0, 1, 500, 1200]) {
      const result = makeDenseResult(blockCount);
      const { length } = writeOcrResultToBuffer(view, [result], blockCount);
      // The advertised length must equal what was committed and stay within
      // the usable payload capacity — the root inconsistency of the bug.
      expect(headerLength(view)).toBe(length);
      expect(length).toBeLessThanOrEqual(OCR_RESULTS_PAYLOAD_CAPACITY);

      const decoded = readOcrResultFromBuffer(view);
      expect(decoded?.blocks.length).toBe(blockCount);
    }
  });

  it("flags truncation and preserves fullText when a payload exceeds capacity", () => {
    // Use a tiny synthetic capacity so we can exercise the overflow path
    // deterministically without allocating gigabytes of blocks.
    const fullText = "important recognized screen text";
    const dense = makeDenseResult(200);
    dense.fullText = fullText;
    const smallCapacity = 512;

    const { bytes, truncated } = encodeOcrResultWithinCapacity(
      [dense],
      3,
      1000,
      smallCapacity,
    );
    expect(truncated).toBe(true);
    expect(bytes.length).toBeLessThanOrEqual(smallCapacity);

    const parsed = JSON.parse(bytes.toString("utf-8"));
    expect(parsed.truncated).toBe(true);
    expect(parsed.fullText).toBe(fullText);
    expect(parsed.blocks.length).toBeLessThan(dense.blocks.length);
  });

  it("treats a header length beyond capacity as an explicit error, not a truncated parse", () => {
    const view = new DataView(new ArrayBuffer(OCR_RESULTS_BUFFER_SIZE));
    // Simulate the pre-fix inconsistency: a header advertising more than the
    // buffer can hold. The reader must reject it rather than parse garbage.
    view.setUint32(
      OCR_RESULTS_HEADER_SIZE,
      OCR_RESULTS_PAYLOAD_CAPACITY + 1,
      true,
    );

    expect(() => readOcrResultFromBuffer(view)).toThrowError(
      /exceeds buffer capacity/,
    );

    const manager = new VisionWorkerManager({ ocrEnabled: true } as never);
    const mgrView = Reflect.get(manager, "ocrResultsView") as DataView;
    mgrView.setUint32(
      OCR_RESULTS_HEADER_SIZE,
      OCR_RESULTS_PAYLOAD_CAPACITY + 1,
      true,
    );
    const read = Reflect.get(manager, "readOCRResult").call(
      manager,
    ) as OCRResult | null;
    expect(read).toBeNull();
  });

  it("returns null for an untouched (zero-length) buffer", () => {
    const view = new DataView(new ArrayBuffer(OCR_RESULTS_BUFFER_SIZE));
    expect(readOcrResultFromBuffer(view)).toBeNull();
    expect(OCR_RESULTS_DATA_OFFSET).toBe(32);
  });
});
