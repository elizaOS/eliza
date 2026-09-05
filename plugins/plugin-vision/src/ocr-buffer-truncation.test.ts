/**
 * Regression tests for the OCR results SharedArrayBuffer round-trip and its
 * overflow propagation (issue #29076). These exercise the real shared
 * writer/reader codec in `workers/ocr-results-buffer.ts`, the real reachable
 * `VisionWorkerManager` cache/readiness/enhanced-scene path, and the real
 * `visionProvider` model-facing text — no worker threads, GPU, or display
 * required.
 *
 * Before the fix, a dense frame's OCR JSON larger than the former hardcoded
 * 64KB cap was truncated mid-token, so `JSON.parse` threw and the entire OCR
 * frame was silently discarded even though it fit comfortably in the 5MB
 * buffer. The suite proves such payloads now round-trip intact and that the
 * writer never advertises a header length larger than the bytes it wrote.
 *
 * It also pins the overflow contract at the consumer boundary: when only
 * bounding-box blocks are dropped the recognized text stays complete and the
 * result is flagged partial through readiness, the enhanced scene, and the
 * provider; when the recognized text alone cannot fit, OCR becomes an explicit
 * unavailable/size-error state and no text prefix is ever presented as complete
 * perception.
 */

import { describe, expect, it } from "vitest";
import { visionProvider } from "./provider";
import type {
  EnhancedSceneDescription,
  OCRResult,
  ScreenCapture,
} from "./types";
import { VisionMode } from "./types";
import { VisionWorkerManager } from "./vision-worker-manager";
import {
  encodeOcrResultWithinCapacity,
  OCR_RESULTS_BUFFER_SIZE,
  OCR_RESULTS_DATA_OFFSET,
  OCR_RESULTS_HEADER_SIZE,
  OCR_RESULTS_PAYLOAD_CAPACITY,
  readOcrResultFromBuffer,
  type SerializedOcrResult,
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

/** Drive a written buffer through the real manager cache path. */
function ingestThroughManager(
  results: OCRResult[],
  capacity: number,
): VisionWorkerManager {
  const manager = new VisionWorkerManager({ ocrEnabled: true } as never);
  const view = Reflect.get(manager, "ocrResultsView") as DataView;
  writeOcrResultToBuffer(view, results, 1, 1000, capacity);
  // updateOCRCache is what the OCR worker's `ocr_complete` message triggers.
  Reflect.get(manager, "updateOCRCache").call(manager, {
    type: "ocr_complete",
  });
  return manager;
}

/**
 * Render the provider's model-facing perception text for a SCREEN-mode scene.
 * All collaborators are stubbed except the enhanced scene under test, so the
 * assertions exercise the real provider formatting of OCR overflow state.
 */
async function renderProviderText(
  scene: EnhancedSceneDescription,
): Promise<string> {
  const screenCapture: ScreenCapture = {
    timestamp: Date.now(),
    width: 1920,
    height: 1080,
    data: Buffer.alloc(0),
    tiles: [],
  };
  const visionService = {
    getEnhancedSceneDescription: async () => scene,
    getSceneDescription: async () => scene,
    getCameraInfo: () => null,
    isActive: () => true,
    getVisionMode: () => VisionMode.SCREEN,
    getScreenCapture: async () => screenCapture,
    getCapabilities: () => ({
      objectDetection: false,
      ocr: true,
      faceRecognition: false,
      screenCapture: true,
      camera: false,
      audio: false,
    }),
    getEntityTracker: () => null,
  };
  const runtime = {
    getService: () => visionService,
  } as never;
  const result = await visionProvider.get(
    runtime,
    { worldId: "w" } as never,
    {} as never,
  );
  // The full serialized provider text is what the model receives: it carries
  // both the human-readable `summary` and the `sceneDescription` value.
  return result.text ?? "";
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
    ) as SerializedOcrResult | null;
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
    ) as SerializedOcrResult | null;
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

    const outcome = encodeOcrResultWithinCapacity(
      [dense],
      3,
      1000,
      smallCapacity,
    );
    expect(outcome.truncated).toBe(true);
    expect(outcome.textOverflow).toBe(false);
    expect(outcome.omittedBlocks).toBeGreaterThan(0);
    expect(outcome.bytes.length).toBeLessThanOrEqual(smallCapacity);

    const parsed = JSON.parse(outcome.bytes.toString("utf-8"));
    expect(parsed.truncated).toBe(true);
    expect(parsed.textOverflow).toBe(false);
    // The recognized text must be preserved in full; only box metadata is cut.
    expect(parsed.fullText).toBe(fullText);
    expect(parsed.blocks.length).toBeLessThan(dense.blocks.length);
    expect(parsed.totalBlocks).toBe(dense.blocks.length);
    expect(parsed.omittedBlocks).toBe(
      dense.blocks.length - parsed.blocks.length,
    );
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
    ) as SerializedOcrResult | null;
    expect(read).toBeNull();
  });

  it("returns null for an untouched (zero-length) buffer", () => {
    const view = new DataView(new ArrayBuffer(OCR_RESULTS_BUFFER_SIZE));
    expect(readOcrResultFromBuffer(view)).toBeNull();
    expect(OCR_RESULTS_DATA_OFFSET).toBe(32);
  });
});

describe("OCR overflow propagation to consumers (issue #29076 review)", () => {
  it("surfaces a blocks-dropped result as partial while keeping the complete text visible", async () => {
    const fullText =
      "line one of recognized screen text with plenty of words to render";
    const dense = makeDenseResult(300);
    dense.fullText = fullText;
    // Capacity big enough to hold the full text but not all bounding boxes.
    const capacity = 800;

    const manager = ingestThroughManager([dense], capacity);

    // Text is complete, so OCR stays ready and the manager reports omission.
    expect(manager.getReadiness().ocr).toBe(true);
    const scene = manager.getLatestEnhancedScene();
    expect(scene.description).toBe(fullText);
    expect(scene.screenAnalysis?.fullScreenOCR).toBe(fullText);
    expect(scene.screenAnalysis?.ocrSizeError).toBeUndefined();
    const truncation = scene.screenAnalysis?.ocrTruncation;
    expect(truncation).toBeDefined();
    expect(truncation?.totalBlocks).toBe(dense.blocks.length);
    expect(truncation?.omittedBlocks).toBeGreaterThan(0);
    expect(truncation?.omittedBlocks).toBeLessThan(dense.blocks.length);

    const text = await renderProviderText(scene);
    // Provider shows the complete recognized text plus a visible partial note.
    expect(text).toContain(fullText);
    expect(text).toContain("were omitted to fit the transfer buffer");
    expect(text).not.toContain("unavailable");
  });

  it("surfaces a text-only overflow as an explicit size error, never a text prefix", async () => {
    // A single result whose recognized text alone dwarfs a tiny capacity.
    const fullText = "S".repeat(4096);
    const result: OCRResult = { text: fullText, fullText, blocks: [] };
    const capacity = 256;

    const outcome = encodeOcrResultWithinCapacity([result], 9, 1000, capacity);
    expect(outcome.textOverflow).toBe(true);
    expect(outcome.overflowTextBytes).toBe(
      Buffer.byteLength(fullText, "utf-8"),
    );
    expect(outcome.bytes.length).toBeLessThanOrEqual(capacity);
    // The codec must not emit any of the recognized text as a prefix.
    const parsed = JSON.parse(outcome.bytes.toString("utf-8"));
    expect(parsed.fullText).toBe("");
    expect(parsed.blocks).toEqual([]);

    const manager = ingestThroughManager([result], capacity);

    // OCR is unavailable for this frame: no partial value is presented.
    expect(manager.getReadiness().ocr).toBe(false);
    const scene = manager.getLatestEnhancedScene();
    expect(scene.description).toBe("");
    expect(scene.screenAnalysis?.fullScreenOCR).toBeUndefined();
    expect(scene.screenAnalysis?.ocrTruncation).toBeUndefined();
    const sizeError = scene.screenAnalysis?.ocrSizeError;
    expect(sizeError).toBeDefined();
    expect(sizeError?.textBytes).toBe(Buffer.byteLength(fullText, "utf-8"));
    expect(sizeError?.capacity).toBe(OCR_RESULTS_PAYLOAD_CAPACITY);

    const text = await renderProviderText(scene);
    // Provider renders an explicit unavailable state and never leaks the text.
    expect(text).toContain("Screen OCR unavailable");
    expect(text).not.toContain(fullText);
    expect(text).not.toContain("SSSS");
  });
});
