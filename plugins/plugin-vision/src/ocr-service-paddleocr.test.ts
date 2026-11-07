/**
 * Unit coverage for the PaddleOCR JSON contract. The wrapper is ours, so a
 * payload we cannot parse means the run failed; it must not be flattened into
 * "no text on screen" for the caller. Runs without a PaddleOCR install.
 */

import { describe, expect, it } from "vitest";
import { parsePaddleOcrJson } from "./ocr-service-paddleocr";

const QUAD = [
  [10, 20],
  [110, 20],
  [110, 60],
  [10, 60],
];

function errorCode(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return (err as { code?: unknown }).code;
  }
  return undefined;
}

describe("parsePaddleOcrJson", () => {
  it("rejects a non-JSON wrapper output instead of returning no text", () => {
    expect(() => parsePaddleOcrJson("<html>502 Bad Gateway</html>")).toThrow(
      /unreadable JSON/,
    );
    expect(() => parsePaddleOcrJson("")).toThrow(/unreadable JSON/);
    expect(() => parsePaddleOcrJson("[] trailing garbage")).toThrow(
      /unreadable JSON/,
    );
    expect(
      errorCode(() => parsePaddleOcrJson("<html>502 Bad Gateway</html>")),
    ).toBe("VISION_OCR_UNREADABLE_OUTPUT");
  });

  it("rejects a JSON payload that is not a detection array", () => {
    expect(() => parsePaddleOcrJson('{"error":"paddleocr crashed"}')).toThrow(
      /non-array payload/,
    );
    expect(
      errorCode(() => parsePaddleOcrJson('{"error":"paddleocr crashed"}')),
    ).toBe("VISION_OCR_UNREADABLE_OUTPUT");
  });

  it("keeps an empty array for a healthy run that found no text", () => {
    expect(parsePaddleOcrJson("[]")).toEqual([]);
  });

  it("maps a valid detection to a typed line block", () => {
    const dets = parsePaddleOcrJson(
      JSON.stringify([{ box: QUAD, text: "Submit 4200", conf: 0.93 }]),
    );
    expect(dets).toHaveLength(1);
    expect(dets[0]?.text).toBe("Submit 4200");
    expect(dets[0]?.conf).toBeCloseTo(0.93);
  });

  it("still drops individual entries that are not real detections", () => {
    const dets = parsePaddleOcrJson(
      JSON.stringify([
        { box: QUAD, text: "keep", conf: 0.9 },
        { box: [[0, 0]], text: "two-point box", conf: 0.9 },
        { box: QUAD, text: "  ", conf: 0.9 },
        { box: QUAD, text: "bad conf", conf: Number.NaN },
      ]),
    );
    expect(dets.map((d) => d.text)).toEqual(["keep"]);
  });
});
