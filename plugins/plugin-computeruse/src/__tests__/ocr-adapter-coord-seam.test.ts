/**
 * scene-builder OCR adapter — coord seam preference + line-only fallback.
 *
 * Regression coverage for the unified OCR seam (issue #9105 / M1): the
 * scene-builder must consume the coord-aware `CoordOcrProvider` when one is
 * registered (e.g. the plugin-vision bridge), map its blocks to SceneOcrBoxes
 * in display-absolute coords, and fall back to the line-only `OcrProvider`
 * registry only when no coord provider is present.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetOcrProvidersForTests,
  type CoordOcrProvider,
  type OcrProvider,
  registerCoordOcrProvider,
  registerOcrProvider,
} from "../mobile/ocr-provider.js";
import {
  makeOcrIdState,
  runOcrOnPng,
  runOcrOnRegions,
} from "../scene/ocr-adapter.js";

function fakeCoordProvider(name = "fake-coord"): CoordOcrProvider {
  return {
    name,
    // Echoes sourceX/sourceY into the returned block bbox so callers can prove
    // the offset is threaded through (matches the real adapter's shift).
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
            text: "Cancel",
            bbox: {
              x: input.sourceX + 60,
              y: input.sourceY + 20,
              width: 50,
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

function fakeLineProvider(name = "fake-line"): OcrProvider {
  return {
    name,
    priority: 1,
    available: () => true,
    async recognize() {
      return {
        lines: [
          {
            text: "LineOnly",
            boundingBox: { x: 1, y: 2, width: 3, height: 4 },
            confidence: 0.5,
          },
        ],
        fullText: "LineOnly",
        elapsedMs: 0,
        providerName: name,
        languagesUsed: [],
      };
    },
  };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe("ocr-adapter coord seam", () => {
  beforeEach(() => {
    _resetOcrProvidersForTests();
    registerCoordOcrProvider(null);
  });
  afterEach(() => {
    _resetOcrProvidersForTests();
    registerCoordOcrProvider(null);
  });

  it("maps CoordOcrProvider blocks to SceneOcrBoxes (full frame)", async () => {
    registerCoordOcrProvider(fakeCoordProvider());
    const boxes = await runOcrOnPng(PNG, 0, makeOcrIdState());
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toMatchObject({
      text: "Save",
      bbox: [10, 20, 40, 16],
      conf: 1,
      displayId: 0,
    });
    expect(boxes[0].id).toBe("t0-1");
    expect(boxes[1]).toMatchObject({ text: "Cancel", bbox: [60, 20, 50, 16] });
    expect(boxes[1].id).toBe("t0-2");
  });

  it("prefers the coord seam over a registered line-only provider", async () => {
    registerOcrProvider(fakeLineProvider());
    registerCoordOcrProvider(fakeCoordProvider());
    const boxes = await runOcrOnPng(PNG, 1, makeOcrIdState());
    // Coord provider wins → "Save"/"Cancel", not "LineOnly".
    expect(boxes.map((b) => b.text)).toEqual(["Save", "Cancel"]);
    expect(boxes.every((b) => b.displayId === 1)).toBe(true);
  });

  it("falls back to the line-only registry when no coord provider", async () => {
    registerOcrProvider(fakeLineProvider());
    const boxes = await runOcrOnPng(PNG, 2, makeOcrIdState());
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({
      text: "LineOnly",
      bbox: [1, 2, 3, 4],
      conf: 0.5,
      displayId: 2,
    });
  });

  it("returns empty when nothing is registered", async () => {
    const boxes = await runOcrOnPng(PNG, 0, makeOcrIdState());
    expect(boxes).toEqual([]);
  });

  it("threads the crop offset through the coord seam for dirty regions", async () => {
    registerCoordOcrProvider(fakeCoordProvider());
    const boxes = await runOcrOnRegions(
      [{ png: PNG, bbox: [100, 200, 80, 40] }],
      0,
      makeOcrIdState(),
    );
    // The provider echoes sourceX/sourceY (100/200) into the block bbox; the
    // returned coords must already be display-absolute (no double-shift).
    expect(boxes).toHaveLength(2);
    expect(boxes[0].bbox).toEqual([110, 220, 40, 16]);
    expect(boxes[1].bbox).toEqual([160, 220, 50, 16]);
  });
});
