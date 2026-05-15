/**
 * Tests for the `OcrWithCoordsService` interface and the transitional
 * `RapidOcrCoordAdapter`. These verify:
 *   1. `computeSemanticPosition` matches the strict-thirds rule exactly,
 *      including the "middle + center" → "center" collapse.
 *   2. `readPngDimensions` parses a synthesized minimal PNG correctly.
 *   3. `RapidOcrCoordAdapter.describe` shifts tile-relative bboxes into
 *      source-display absolute coords given a non-zero `sourceX`/`sourceY`,
 *      and computes per-block / per-word `semantic_position` against the
 *      *tile* dims (not the shifted absolute coords).
 *   4. Empty input returns `{blocks: []}` with no calls to the underlying
 *      RapidOCR worker.
 *
 * The adapter is fed a stub that mimics the public surface of
 * `RapidOCRService.extractText` so we don't need onnxruntime-node or any
 * network access.
 */

import { Buffer } from "node:buffer";
import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  computeSemanticPosition,
  RapidOcrCoordAdapter,
  readPngDimensions,
  type OcrWithCoordsBlock,
} from "./ocr-with-coords";
import type { RapidOCRService } from "./ocr-service-rapid";
import type { OCRResult } from "./types";

// ── PNG synth helper ────────────────────────────────────────────────────────

const PNG_SIG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n >>> 0;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.byteLength; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.byteLength + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.byteLength, false);
  for (let i = 0; i < 4; i += 1) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(data, 8);
  const crcInput = new Uint8Array(4 + data.byteLength);
  for (let i = 0; i < 4; i += 1) crcInput[i] = type.charCodeAt(i);
  crcInput.set(data, 4);
  view.setUint32(8 + data.byteLength, crc32(crcInput), false);
  return out;
}

/**
 * Build a minimal valid PNG of the requested width/height. Pixel content is
 * irrelevant — the adapter only reads dimensions and forwards the bytes to a
 * stubbed RapidOCR.
 */
function makePng(width: number, height: number): Uint8Array {
  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(ihdrData.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // RGB
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = chunk("IHDR", ihdrData);

  // Single-pixel rows of zeroed RGB data, with a leading filter byte per row.
  const rowBytes = 1 + width * 3;
  const raw = new Uint8Array(rowBytes * height);
  const idatData = new Uint8Array(deflateSync(Buffer.from(raw)));
  const idat = chunk("IDAT", idatData);
  const iend = chunk("IEND", new Uint8Array(0));

  const total = new Uint8Array(
    PNG_SIG.byteLength + ihdr.byteLength + idat.byteLength + iend.byteLength,
  );
  let offset = 0;
  total.set(PNG_SIG, offset);
  offset += PNG_SIG.byteLength;
  total.set(ihdr, offset);
  offset += ihdr.byteLength;
  total.set(idat, offset);
  offset += idat.byteLength;
  total.set(iend, offset);
  return total;
}

// ── computeSemanticPosition ─────────────────────────────────────────────────

describe("computeSemanticPosition", () => {
  const tileWidth = 300;
  const tileHeight = 300;

  // (centerX, centerY) → expected. Centers are the bbox center; we provide
  // 1x1 boxes so center == bbox.x.
  const cases: ReadonlyArray<readonly [number, number, string]> = [
    [50, 50, "upper-left"],
    [150, 50, "upper-center"],
    [250, 50, "upper-right"],
    [50, 150, "middle-left"],
    [150, 150, "center"],
    [250, 150, "middle-right"],
    [50, 250, "lower-left"],
    [150, 250, "lower-center"],
    [250, 250, "lower-right"],
  ];

  for (const [cx, cy, expected] of cases) {
    it(`maps center (${cx}, ${cy}) to ${expected}`, () => {
      const got = computeSemanticPosition({
        bbox: { x: cx, y: cy, width: 0, height: 0 },
        tileWidth,
        tileHeight,
      });
      expect(got).toBe(expected);
    });
  }

  it("clamps centers past the right/bottom edge into the lower-right cell", () => {
    expect(
      computeSemanticPosition({
        bbox: { x: 999, y: 999, width: 0, height: 0 },
        tileWidth,
        tileHeight,
      }),
    ).toBe("lower-right");
  });

  it("rejects non-positive tile dims (no silent fallback)", () => {
    expect(() =>
      computeSemanticPosition({
        bbox: { x: 0, y: 0, width: 1, height: 1 },
        tileWidth: 0,
        tileHeight: 100,
      }),
    ).toThrow(/tile dims/);
  });
});

// ── readPngDimensions ───────────────────────────────────────────────────────

describe("readPngDimensions", () => {
  it("parses a synthesized 320x240 PNG", async () => {
    const png = makePng(320, 240);
    const dims = await readPngDimensions(png);
    expect(dims).toEqual({ width: 320, height: 240 });
  });

  it("rejects non-PNG inputs", async () => {
    await expect(readPngDimensions(new Uint8Array(64))).rejects.toThrow(
      /PNG signature/,
    );
  });
});

// ── RapidOcrCoordAdapter.describe ───────────────────────────────────────────

function stubRapid(result: OCRResult): RapidOCRService {
  // Cast through `unknown` because we deliberately stub only the surface the
  // adapter touches; `RapidOCRService` carries onnxruntime-node session
  // members that have no role here.
  const stub = {
    extractText: vi.fn(async () => result),
  };
  return stub as unknown as RapidOCRService;
}

describe("RapidOcrCoordAdapter.describe", () => {
  it("returns an empty result for empty input without invoking the worker", async () => {
    const inner = stubRapid({ text: "", blocks: [], fullText: "" });
    const adapter = new RapidOcrCoordAdapter(inner);
    const result = await adapter.describe({
      displayId: "display-0",
      sourceX: 100,
      sourceY: 200,
      pngBytes: new Uint8Array(0),
    });
    expect(result.blocks).toEqual([]);
    expect(
      (inner as unknown as { extractText: ReturnType<typeof vi.fn> })
        .extractText,
    ).not.toHaveBeenCalled();
  });

  it("shifts bboxes into source-display absolute coords and labels semantic_position against the tile", async () => {
    const tileWidth = 300;
    const tileHeight = 300;
    const png = makePng(tileWidth, tileHeight);
    const sourceX = 1000;
    const sourceY = 2000;

    // Two blocks: one in the upper-left third of the tile, one in the
    // lower-right third. Each carries one word at the same coordinates.
    const fakeOcr: OCRResult = {
      text: "hello world",
      fullText: "hello world",
      blocks: [
        {
          text: "hello",
          confidence: 0.9,
          bbox: { x: 30, y: 30, width: 40, height: 20 },
          words: [
            {
              text: "hello",
              confidence: 0.9,
              bbox: { x: 30, y: 30, width: 40, height: 20 },
            },
          ],
        },
        {
          text: "world",
          confidence: 0.85,
          bbox: { x: 230, y: 230, width: 40, height: 20 },
          words: [
            {
              text: "world",
              confidence: 0.85,
              bbox: { x: 230, y: 230, width: 40, height: 20 },
            },
          ],
        },
      ],
    };

    const adapter = new RapidOcrCoordAdapter(stubRapid(fakeOcr));
    const result = await adapter.describe({
      displayId: "display-0",
      sourceX,
      sourceY,
      pngBytes: png,
    });

    expect(result.blocks).toHaveLength(2);

    const upper = result.blocks[0] as OcrWithCoordsBlock;
    expect(upper.text).toBe("hello");
    expect(upper.bbox).toEqual({
      x: 30 + sourceX,
      y: 30 + sourceY,
      width: 40,
      height: 20,
    });
    expect(upper.semantic_position).toBe("upper-left");
    expect(upper.words).toHaveLength(1);
    expect(upper.words[0]).toEqual({
      text: "hello",
      bbox: { x: 30 + sourceX, y: 30 + sourceY, width: 40, height: 20 },
      semantic_position: "upper-left",
    });

    const lower = result.blocks[1] as OcrWithCoordsBlock;
    expect(lower.text).toBe("world");
    expect(lower.bbox).toEqual({
      x: 230 + sourceX,
      y: 230 + sourceY,
      width: 40,
      height: 20,
    });
    expect(lower.semantic_position).toBe("lower-right");
    expect(lower.words[0].semantic_position).toBe("lower-right");
  });

  it("handles blocks without a words array by emitting an empty words list", async () => {
    const png = makePng(300, 300);
    const fakeOcr: OCRResult = {
      text: "x",
      fullText: "x",
      blocks: [
        {
          text: "x",
          confidence: 0.5,
          bbox: { x: 140, y: 140, width: 20, height: 20 },
        },
      ],
    };
    const adapter = new RapidOcrCoordAdapter(stubRapid(fakeOcr));
    const result = await adapter.describe({
      displayId: "display-0",
      sourceX: 0,
      sourceY: 0,
      pngBytes: png,
    });
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].words).toEqual([]);
    expect(result.blocks[0].semantic_position).toBe("center");
  });
});
