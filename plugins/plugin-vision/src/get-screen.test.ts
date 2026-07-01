/**
 * Unit tests for GET_SCREEN core (M2, #9105).
 *
 * Verifies the token-frugal contract: OCR text + grounded elements by default,
 * NO image unless includeImage=true, graceful behavior when no OCR provider.
 */

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  buildGetScreen,
  type GetScreenResult,
  summarizeGetScreen,
} from "./get-screen.js";
import type { OcrWithCoordsService } from "./ocr-with-coords.js";

function fakeOcr(): OcrWithCoordsService {
  return {
    name: "fake",
    async describe(input) {
      return {
        blocks: [
          {
            text: "Save",
            bbox: {
              x: input.sourceX + 10,
              y: input.sourceY + 20,
              width: 40,
              height: 16,
            },
            words: [],
            semantic_position: "upper-left",
          },
          {
            text: "Open File",
            bbox: {
              x: input.sourceX + 80,
              y: input.sourceY + 20,
              width: 70,
              height: 16,
            },
            words: [],
            semantic_position: "upper-center",
          },
        ],
      };
    },
  };
}

async function png(width = 120, height = 48): Promise<Uint8Array> {
  const buf = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

describe("buildGetScreen", () => {
  it("returns OCR text + elements and OMITS the image by default", async () => {
    const r = await buildGetScreen({
      pngBytes: await png(),
      displayId: 0,
      capturedAt: 1234,
      ocrService: fakeOcr(),
    });
    expect(r.op).toBe("get_screen");
    expect(r.width).toBe(120);
    expect(r.height).toBe(48);
    expect(r.lastChangeTime).toBe(1234);
    expect(r.ocrAvailable).toBe(true);
    expect(r.elementCount).toBe(2);
    expect(r.elements.map((e) => e.text)).toEqual(["Save", "Open File"]);
    expect(r.elements[0]).toMatchObject({
      index: 1,
      id: "el-1",
      bbox: [10, 20, 40, 16],
      center: { x: 30, y: 28 },
      semantic_position: "upper-left",
      displayId: 0,
    });
    // Set-of-Marks numbering is monotonic and 1-based.
    expect(r.elements.map((e) => e.index)).toEqual([1, 2]);
    expect(r.elements[1]?.center).toEqual({ x: 115, y: 28 });
    expect(r.ocrText).toBe("Save\nOpen File");
    expect(r.image).toBeUndefined();
  });

  it("attaches the base64 image only when includeImage=true", async () => {
    const bytes = await png();
    const r = await buildGetScreen({
      pngBytes: bytes,
      includeImage: true,
      ocrService: fakeOcr(),
    });
    expect(typeof r.image).toBe("string");
    expect(Buffer.from(r.image as string, "base64").byteLength).toBe(
      bytes.byteLength,
    );
  });

  it("skips OCR when includeOcr=false (zero work, ocrAvailable=false)", async () => {
    const r = await buildGetScreen({
      pngBytes: await png(),
      includeOcr: false,
      ocrService: fakeOcr(),
    });
    expect(r.ocrAvailable).toBe(false);
    expect(r.elements).toEqual([]);
    expect(r.ocrText).toBe("");
  });

  it("degrades when no OCR provider is registered (never throws)", async () => {
    const r = await buildGetScreen({ pngBytes: await png(), ocrService: null });
    expect(r.ocrAvailable).toBe(false);
    expect(r.elementCount).toBe(0);
    expect(r.width).toBe(120);
  });
});

describe("summarizeGetScreen", () => {
  it("summarizes detected elements", () => {
    const r: GetScreenResult = {
      op: "get_screen",
      displayId: 0,
      width: 800,
      height: 600,
      lastChangeTime: 0,
      ocrAvailable: true,
      ocrText: "Save\nOpen",
      elements: [
        {
          index: 1,
          id: "el-1",
          text: "Save",
          bbox: [0, 0, 1, 1],
          center: { x: 0, y: 0 },
          semantic_position: "center",
          displayId: 0,
        },
        {
          index: 2,
          id: "el-2",
          text: "Open",
          bbox: [0, 0, 1, 1],
          center: { x: 0, y: 0 },
          semantic_position: "center",
          displayId: 0,
        },
      ],
      elementCount: 2,
    };
    expect(summarizeGetScreen(r)).toContain("2 text element");
    // Summary lists the Set-of-Marks numbers so a model can pick "[1]" / "[2]".
    expect(summarizeGetScreen(r)).toContain("[1] Save | [2] Open");
  });

  it("notes when no OCR provider is present", () => {
    const r: GetScreenResult = {
      op: "get_screen",
      displayId: 0,
      width: 800,
      height: 600,
      lastChangeTime: 0,
      ocrAvailable: false,
      ocrText: "",
      elements: [],
      elementCount: 0,
    };
    expect(summarizeGetScreen(r)).toMatch(/No OCR provider/i);
  });
});
