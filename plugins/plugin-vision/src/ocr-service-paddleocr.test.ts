/**
 * Parser and mapper tests for the PaddleOCR Python wrapper JSON contract.
 *
 * CI exercises the pure conversion path without requiring a real PaddleOCR
 * install while keeping the wrapper and parser shape anchored.
 */

import { describe, expect, it } from "vitest";
import {
  mapPaddleOcrJsonToResult,
  parsePaddleOcrJson,
} from "./ocr-service-paddleocr.js";

describe("parsePaddleOcrJson (#9581)", () => {
  it("parses well-formed detections", () => {
    const json = JSON.stringify([
      {
        box: [
          [24, 36],
          [304, 34],
          [304, 72],
          [24, 74],
        ],
        text: "Hello World",
        conf: 0.998,
      },
    ]);
    const dets = parsePaddleOcrJson(json);
    expect(dets).toHaveLength(1);
    expect(dets[0].text).toBe("Hello World");
    expect(dets[0].conf).toBeCloseTo(0.998);
    expect(dets[0].box).toHaveLength(4);
  });

  it("drops malformed entries (no box / blank text / non-finite conf)", () => {
    const json = JSON.stringify([
      { box: [[0, 0]], text: "too few points", conf: 0.9 },
      {
        box: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
        text: "   ",
        conf: 0.9,
      },
      {
        box: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
        text: "no conf",
        conf: "x",
      },
      {
        box: [
          [2, 2],
          [3, 2],
          [3, 3],
          [2, 3],
        ],
        text: "keep",
        conf: 0.5,
      },
    ]);
    const dets = parsePaddleOcrJson(json);
    expect(dets.map((d) => d.text)).toEqual(["keep"]);
  });

  it("returns [] for the empty wrapper result and for invalid JSON", () => {
    expect(parsePaddleOcrJson("[]")).toEqual([]);
    expect(parsePaddleOcrJson("not json")).toEqual([]);
    expect(parsePaddleOcrJson('{"not":"an array"}')).toEqual([]);
  });
});

describe("mapPaddleOcrJsonToResult (#9581)", () => {
  const json = JSON.stringify([
    {
      box: [
        [24, 36],
        [304, 34],
        [304, 72],
        [24, 74],
      ],
      text: "Hello World",
      conf: 0.998,
    },
  ]);

  it("maps a detection quad to an axis-aligned, display-shifted block", () => {
    const result = mapPaddleOcrJsonToResult(json, 400, 400, 100, 200);
    expect(result.blocks).toHaveLength(1);
    const block = result.blocks[0];
    expect(block.text).toBe("Hello World");
    // Hull of the quad is x:24 y:34 w:280 h:40 (tile-relative), shifted by the
    // source offset (100, 200) into display-absolute coordinates.
    expect(block.bbox).toEqual({ x: 124, y: 234, width: 280, height: 40 });
    // The single word is the line itself.
    expect(block.words).toHaveLength(1);
    expect(block.words[0].text).toBe("Hello World");
  });

  it("labels semantic position against the tile thirds", () => {
    // tile center of the hull is (164, 54) in a 400x400 tile → upper third
    // (54 < 133) and center third (133 < 164 < 266).
    const result = mapPaddleOcrJsonToResult(json, 400, 400, 0, 0);
    expect(result.blocks[0].semantic_position).toBe("upper-center");
  });

  it("returns no blocks for the empty result", () => {
    expect(mapPaddleOcrJsonToResult("[]", 400, 400, 0, 0).blocks).toEqual([]);
  });
});
