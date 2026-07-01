/**
 * Tests for the native Windows.Media.Ocr coord provider (M4a, #9105).
 *
 * The pure mapper runs on every platform; the real end-to-end OCR test runs
 * only on a Windows host (and Windows CI) where the WinRT engine exists.
 */

import { platform } from "node:os";
import { describe, expect, it } from "vitest";
import {
  mapWinOcrToResult,
  WindowsMediaOcrService,
} from "./ocr-service-windows.js";

const IS_WIN = platform() === "win32";

describe("mapWinOcrToResult (pure)", () => {
  it("maps lines→blocks with union bbox, word boxes, and source shift", () => {
    const raw = {
      width: 200,
      height: 60,
      lines: [
        {
          text: "Save File",
          words: [
            { text: "Save", x: 10, y: 20, width: 40, height: 16 },
            { text: "File", x: 60, y: 20, width: 36, height: 16 },
          ],
        },
      ],
    };
    const result = mapWinOcrToResult(raw, 100, 200);
    expect(result.blocks).toHaveLength(1);
    const block = result.blocks[0];
    expect(block.text).toBe("Save File");
    // Union of word rects (10..96 x, 20..36 y), shifted by source (100,200).
    expect(block.bbox).toEqual({ x: 110, y: 220, width: 86, height: 16 });
    expect(block.words.map((w) => w.text)).toEqual(["Save", "File"]);
    expect(block.words[0].bbox).toEqual({
      x: 110,
      y: 220,
      width: 40,
      height: 16,
    });
    expect(block.semantic_position).toBeDefined();
  });

  it("drops lines with no words and tolerates zero dimensions", () => {
    const result = mapWinOcrToResult(
      { width: 0, height: 0, lines: [{ text: "", words: [] }] },
      0,
      0,
    );
    expect(result.blocks).toEqual([]);
  });
});

describe("WindowsMediaOcrService", () => {
  it("reports availability by platform", () => {
    expect(WindowsMediaOcrService.isAvailable()).toBe(IS_WIN);
  });

  it("returns empty blocks for empty input (no spawn)", async () => {
    const svc = new WindowsMediaOcrService();
    const r = await svc.describe({
      displayId: "0",
      sourceX: 0,
      sourceY: 0,
      pngBytes: new Uint8Array(0),
    });
    expect(r).toEqual({ blocks: [] });
  });

  it.skipIf(!IS_WIN)(
    "OCRs a rendered PNG via the real WinRT engine (Windows host)",
    async () => {
      const sharp = (await import("sharp")).default;
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="110">' +
        '<rect width="420" height="110" fill="white"/>' +
        '<text x="12" y="70" font-size="40" font-family="Arial, sans-serif" fill="black">Open 4242</text>' +
        "</svg>";
      const png = await sharp(Buffer.from(svg)).png().toBuffer();
      const svc = new WindowsMediaOcrService();
      const r = await svc.describe({
        displayId: "0",
        sourceX: 0,
        sourceY: 0,
        pngBytes: new Uint8Array(png),
      });
      const text = r.blocks.map((b) => b.text).join(" ");
      expect(text).toMatch(/open/i);
      expect(text).toMatch(/4242/);
      expect(
        r.blocks.every(
          (b) => b.bbox.width > 0 && b.bbox.height > 0 && b.words.length > 0,
        ),
      ).toBe(true);
    },
    30000,
  );
});
