/**
 * STUB FOR HARNESS WIRING — replace with the real
 * `OcrWithCoordsService` (`plugins/plugin-vision/src/ocr-with-coords.ts`)
 * before treating any results as real benchmarks.
 *
 * Once the docTR-style OCR-with-coords landing under
 * `packages/native-plugins/doctr-cpp/` ships, the harness should call
 * `getOcrWithCoordsService()` from plugin-vision instead of constructing this
 * stub. The stub returns a tiny canned word grid so downstream stages
 * (grounding, click) have something to read.
 */

import type { OcrCoordResult } from "../types.ts";

export interface StubOcrInput {
  readonly displayId: string;
  readonly sourceX: number;
  readonly sourceY: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
}

export class StubOcrWithCoords {
  readonly name = "stub-ocr-with-coords (HARNESS WIRING ONLY)";

  /**
   * Returns one block with three labels positioned along the top of the tile:
   * `File`, `Edit`, `Close`. All bboxes are returned in display-absolute
   * coordinates (the source tile's `sourceX/sourceY` is added to each
   * tile-local bbox), matching the contract the real `OcrWithCoordsService`
   * follows.
   */
  async describe(input: StubOcrInput): Promise<OcrCoordResult> {
    const { sourceX, sourceY, tileWidth } = input;
    const closeBoxLocal = { x: tileWidth - 140, y: 8, width: 32, height: 32 };
    const editBoxLocal = { x: 80, y: 8, width: 36, height: 20 };
    const fileBoxLocal = { x: 16, y: 8, width: 36, height: 20 };
    return {
      blocks: [
        {
          text: "File Edit Close",
          bbox: shift(
            { x: 0, y: 0, width: tileWidth, height: 48 },
            sourceX,
            sourceY,
          ),
          words: [
            {
              text: "File",
              bbox: shift(fileBoxLocal, sourceX, sourceY),
            },
            {
              text: "Edit",
              bbox: shift(editBoxLocal, sourceX, sourceY),
            },
            {
              text: "Close",
              bbox: shift(closeBoxLocal, sourceX, sourceY),
            },
          ],
        },
      ],
    };
  }
}

function shift(
  b: { x: number; y: number; width: number; height: number },
  dx: number,
  dy: number,
): { x: number; y: number; width: number; height: number } {
  return { x: b.x + dx, y: b.y + dy, width: b.width, height: b.height };
}
