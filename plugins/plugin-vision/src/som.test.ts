/**
 * Set-of-Marks reading-order tests: the numbering a VLM selects from must be
 * top-to-bottom, then left-to-right, for any layout.
 */

import { describe, expect, it } from "vitest";
import { buildSetOfMarks } from "./som";

type TextBox = {
  bbox: [number, number, number, number];
  source: "text";
  label: string;
};

/**
 * A dense two-column list: three rows 10px apart (inside the default 12px
 * `rowTolerance`) and two columns 300px apart.
 */
function denseTwoColumnList(): TextBox[] {
  const boxes: TextBox[] = [];
  for (let row = 0; row < 3; row++) {
    boxes.push({
      bbox: [20, row * 10, 100, 8],
      source: "text",
      label: `a${row}`,
    });
    boxes.push({
      bbox: [320, row * 10, 100, 8],
      source: "text",
      label: `b${row}`,
    });
  }
  return boxes;
}

const labels = (boxes: readonly TextBox[]) =>
  buildSetOfMarks(boxes, { rowTolerance: 12 }).map((mark) => mark.label);

describe("buildSetOfMarks reading order", () => {
  it("keeps a dense two-column list row-ordered instead of interleaving rows", () => {
    // The 10px pitch chains a0~a1~a2 within the 12px tolerance, so a pairwise
    // "same row" comparator has no total order to sort by: it emits
    // a0 a1 b0 a2 b1 b2, where a2 (y=20, x=20) is numbered after b0 (y=0,
    // x=320) but before b1 (y=10, x=320). Every row must be left-to-right and
    // every row must precede the rows below it.
    expect(labels(denseTwoColumnList())).toEqual([
      "a0",
      "a1",
      "b0",
      "b1",
      "a2",
      "b2",
    ]);
  });

  it("numbers the same boxes identically whatever order they arrive in", () => {
    const boxes = denseTwoColumnList();
    const expected = labels(boxes);
    expect(labels([...boxes].reverse())).toEqual(expected);
    expect(
      labels([boxes[0], boxes[2], boxes[4], boxes[1], boxes[3], boxes[5]]),
    ).toEqual(expected);
  });

  it("orders a single row left to right and a single column top to bottom", () => {
    const row: TextBox[] = [
      { bbox: [400, 50, 40, 10], source: "text", label: "right" },
      { bbox: [10, 50, 40, 10], source: "text", label: "left" },
      { bbox: [200, 50, 40, 10], source: "text", label: "middle" },
    ];
    expect(labels(row)).toEqual(["left", "middle", "right"]);

    const column: TextBox[] = [
      { bbox: [10, 300, 40, 10], source: "text", label: "bottom" },
      { bbox: [10, 10, 40, 10], source: "text", label: "top" },
      { bbox: [10, 150, 40, 10], source: "text", label: "middle" },
    ];
    expect(labels(column)).toEqual(["top", "middle", "bottom"]);
  });
});
