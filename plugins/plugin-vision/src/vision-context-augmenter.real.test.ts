/**
 * Real-engine coverage for the describe augmenter's OCR step (#9105).
 *
 * The unit and model-case tests in `vision-context-augmenter.test.ts` record
 * what reaches the recognizer. This suite runs the production augmenter on a
 * JPEG data URL (the shape of a camera frame or a photo upload) of the
 * checked-in screenshot fixture, through the coord-OCR service plugin-vision
 * registers on Linux when tesseract resolves (`LinuxTesseractOcrService`),
 * with the real tesseract binary. Gated like
 * `ocr-service-linux-tesseract.real.test.ts`: it runs when tesseract is on
 * PATH, at `ELIZA_TESSERACT_BIN`, or in the bundle at `ELIZA_VISION_VENDOR_DIR`,
 * and skips otherwise.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { LinuxTesseractOcrService } from "./ocr-service-linux-tesseract";
import {
  type OcrWithCoordsInput,
  type OcrWithCoordsResult,
  readPngDimensionsOrNull,
  registerOcrWithCoordsService,
} from "./ocr-with-coords";
import { FusedVisionContextAugmenter } from "./vision-context-augmenter";

const available = LinuxTesseractOcrService.isAvailable();

const fixturePng = readFileSync(
  fileURLToPath(
    new URL("../test/fixtures/ocr-real-sample.png", import.meta.url),
  ),
);

describe.skipIf(!available)(
  "FusedVisionContextAugmenter — real tesseract over a JPEG describe image",
  () => {
    afterEach(() => registerOcrWithCoordsService(null));

    it("adds the recognized words and gives the engine a PNG of the image's size", async () => {
      const engine = new LinuxTesseractOcrService();
      const calls: Array<{
        input: OcrWithCoordsInput;
        result: OcrWithCoordsResult;
      }> = [];
      registerOcrWithCoordsService({
        name: engine.name,
        async describe(input) {
          const result = await engine.describe(input);
          calls.push({ input, result });
          return result;
        },
      });
      const jpeg = await sharp(fixturePng).jpeg({ quality: 95 }).toBuffer();

      const out = await new FusedVisionContextAugmenter().augmentImagePrompt({
        image: {
          kind: "dataUrl",
          dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
        },
        basePrompt: "What does the screen say?",
      });

      // The fixture renders "Eliza OCR" + "Submit 4200".
      expect(out?.prompt).toContain("- Text (OCR): ");
      expect(out?.fused.ocrText).toMatch(/Eliza/i);
      expect(out?.fused.ocrText).toMatch(/OCR/);
      expect(out?.fused.ocrText).toMatch(/4200/);

      expect(calls).toHaveLength(1);
      expect(readPngDimensionsOrNull(calls[0].input.pngBytes)).toEqual({
        width: 800,
        height: 240,
      });
      // Positions come from the image's real size: the same words and
      // thirds as describing the PNG fixture itself.
      const direct = await engine.describe({
        displayId: "vision-describe",
        sourceX: 0,
        sourceY: 0,
        pngBytes: new Uint8Array(fixturePng),
      });
      const placed = (result: OcrWithCoordsResult) =>
        result.blocks.map((block) => [block.text, block.semantic_position]);
      expect(placed(calls[0].result)).toEqual(placed(direct));
    });
  },
);
