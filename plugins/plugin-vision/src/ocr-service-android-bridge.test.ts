/**
 * Mapping tests for native Android OCR words into shared OCR result records.
 */

import { describe, expect, it } from "vitest";
import type { OcrBridgeWord } from "./ocr-bridge.js";
import { mapOcrWordsToResult } from "./ocr-service-android-bridge.js";

function word(
  overrides: Partial<OcrBridgeWord> & { text: string },
): OcrBridgeWord {
  return {
    left: 0,
    top: 0,
    width: 10,
    height: 10,
    confidence: 90,
    block: 0,
    par: 0,
    line: 0,
    ...overrides,
  };
}

describe("mapOcrWordsToResult", () => {
  it("groups native words by block/paragraph/line and shifts to display coords", () => {
    const result = mapOcrWordsToResult(
      [
        word({
          text: "Save",
          left: 10,
          top: 20,
          width: 40,
          height: 16,
          block: 1,
          par: 1,
          line: 1,
        }),
        word({
          text: "File",
          left: 60,
          top: 20,
          width: 36,
          height: 16,
          block: 1,
          par: 1,
          line: 1,
        }),
        word({
          text: "Cancel",
          left: 10,
          top: 44,
          width: 52,
          height: 16,
          block: 1,
          par: 1,
          line: 2,
        }),
      ],
      200,
      60,
      100,
      200,
    );

    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0].text).toBe("Save File");
    expect(result.blocks[0].bbox).toEqual({
      x: 110,
      y: 220,
      width: 86,
      height: 16,
    });
    expect(result.blocks[0].words.map((item) => item.text)).toEqual([
      "Save",
      "File",
    ]);
    expect(result.blocks[1].text).toBe("Cancel");
    expect(result.blocks[1].bbox).toEqual({
      x: 110,
      y: 244,
      width: 52,
      height: 16,
    });
  });

  it("keeps identical line numbers in different blocks or paragraphs separate", () => {
    const result = mapOcrWordsToResult(
      [
        word({ text: "A", block: 0, par: 0, line: 0 }),
        word({ text: "B", block: 0, par: 1, line: 0 }),
        word({ text: "C", block: 1, par: 0, line: 0 }),
      ],
      100,
      100,
      0,
      0,
    );

    expect(result.blocks.map((block) => block.text)).toEqual(["A", "B", "C"]);
  });

  it("skips blank words and tolerates zero tile dimensions", () => {
    const result = mapOcrWordsToResult(
      [word({ text: "  " }), word({ text: "x", left: 5 })],
      0,
      0,
      0,
      0,
    );

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].text).toBe("x");
    expect(result.blocks[0].semantic_position).toBeDefined();
  });
});
