/**
 * Real-engine coverage for the Linux tesseract OCR service (#9105).
 *
 * Every other OCR test in this package injects a FAKE OcrWithCoordsService or
 * feeds a canned TSV string — the real `LinuxTesseractOcrService.describe()`
 * spawn path (render PNG → `tesseract … tsv` → map to absolute-display blocks)
 * had zero executable coverage. This drives a real checked-in screenshot
 * fixture (real antialiased glyphs) through the real binary.
 *
 * Gated on `LinuxTesseractOcrService.isAvailable()`: it runs when tesseract is
 * resolvable (on PATH, via `ELIZA_TESSERACT_BIN`, or the vendored bundle at
 * `ELIZA_VISION_VENDOR_DIR` — see `scripts/vendor-tesseract-linux.mjs`) and
 * skips cleanly otherwise, so CI without the bundle stays green.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LinuxTesseractOcrService } from "./ocr-service-linux-tesseract";

const available = LinuxTesseractOcrService.isAvailable();

const fixturePng = readFileSync(
  fileURLToPath(
    new URL("../test/fixtures/ocr-real-sample.png", import.meta.url),
  ),
);

describe.skipIf(!available)(
  "LinuxTesseractOcrService — real engine over a real screenshot",
  () => {
    it("recognizes the rendered words with absolute-display boxes", async () => {
      const svc = new LinuxTesseractOcrService();
      const sourceX = 100;
      const sourceY = 50;
      const result = await svc.describe({
        displayId: "real-fixture",
        sourceX,
        sourceY,
        pngBytes: new Uint8Array(fixturePng),
      });

      expect(result.blocks.length).toBeGreaterThan(0);
      const allText = result.blocks.map((b) => b.text).join(" ");
      // The fixture renders "Eliza OCR" + "Submit 4200".
      expect(allText).toMatch(/Eliza/i);
      expect(allText).toMatch(/OCR/i);
      expect(allText).toMatch(/4200/);

      // Boxes are absolute source-display coords: the tile offset is applied,
      // so every box sits at/after the offset (never tile-relative origin).
      for (const block of result.blocks) {
        expect(block.bbox.x).toBeGreaterThanOrEqual(sourceX);
        expect(block.bbox.y).toBeGreaterThanOrEqual(sourceY);
        expect(block.bbox.width).toBeGreaterThan(0);
        expect(block.bbox.height).toBeGreaterThan(0);
        expect(block.words.length).toBeGreaterThan(0);
        // Words carry their own absolute box + a semantic position.
        for (const word of block.words) {
          expect(word.text.length).toBeGreaterThan(0);
          expect(word.bbox.x).toBeGreaterThanOrEqual(sourceX);
          expect(word.bbox.width).toBeGreaterThan(0);
          expect(word.semantic_position).toBeTruthy();
        }
      }
    });

    it("returns empty blocks for empty input without spawning tesseract", async () => {
      const svc = new LinuxTesseractOcrService();
      const result = await svc.describe({
        displayId: "empty",
        sourceX: 0,
        sourceY: 0,
        pngBytes: new Uint8Array(0),
      });
      expect(result.blocks).toEqual([]);
    });
  },
);
