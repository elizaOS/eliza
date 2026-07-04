/**
 * Screen-element fusion tests for merging OCR, accessibility, and VLM boxes.
 */

import { describe, expect, it } from "vitest";
import {
  type AxNodeLike,
  bboxIou,
  type GetScreenElement,
  mergeScreenElements,
  type OcrBoxLike,
  type VlmElementLike,
} from "./get-screen-elements.js";

const ocr = (
  id: string,
  text: string,
  bbox: [number, number, number, number],
  displayId = 0,
): OcrBoxLike => ({ id, text, bbox, conf: 0.9, displayId });

const ax = (
  id: string,
  role: string,
  label: string | undefined,
  bbox: [number, number, number, number],
  actions: string[] = ["press"],
  displayId = 0,
): AxNodeLike => ({ id, role, label, bbox, actions, displayId });

const vlm = (
  id: string,
  kind: string,
  desc: string,
  bbox: [number, number, number, number],
  displayId = 0,
): VlmElementLike => ({ id, kind, desc, bbox, displayId });

describe("bboxIou", () => {
  it("is 1 for identical boxes and 0 for disjoint", () => {
    expect(bboxIou([0, 0, 10, 10], [0, 0, 10, 10])).toBeCloseTo(1);
    expect(bboxIou([0, 0, 10, 10], [100, 100, 10, 10])).toBe(0);
  });
  it("returns 0 for an empty box", () => {
    expect(bboxIou([0, 0, 0, 10], [0, 0, 10, 10])).toBe(0);
  });
  it("is ~0.33 for half-overlapping equal boxes", () => {
    // [0,0,10,10] and [5,0,10,10]: inter=5*10=50, union=100+100-50=150 → 1/3.
    expect(bboxIou([0, 0, 10, 10], [5, 0, 10, 10])).toBeCloseTo(1 / 3, 5);
  });
});

describe("mergeScreenElements (#9105 GET_SCREEN element merge)", () => {
  it("maps OCR-only input to elements with groundingSources=['ocr']", () => {
    const out = mergeScreenElements({
      ocr: [
        ocr("o1", "Save", [10, 10, 40, 12]),
        ocr("o2", "Cancel", [60, 10, 40, 12]),
      ],
    });
    expect(out).toHaveLength(2);
    expect(
      out.every(
        (e) =>
          e.groundingSources.length === 1 && e.groundingSources[0] === "ocr",
      ),
    ).toBe(true);
    expect(out.map((e) => e.text)).toEqual(["Save", "Cancel"]);
  });

  it("collapses an AX node overlapping an OCR box into ONE element, AX label/role winning", () => {
    const out = mergeScreenElements({
      ocr: [ocr("o1", "save", [10, 10, 40, 12])],
      ax: [ax("a1", "button", "Save document", [11, 10, 40, 12])],
    });
    expect(out).toHaveLength(1);
    const el = out[0] as GetScreenElement;
    expect(el.groundingSources.sort()).toEqual(["ax", "ocr"]);
    expect(el.id).toBe("a1"); // AX id wins
    expect(el.text).toBe("Save document"); // AX label wins over OCR text
    expect(el.kind).toBe("button"); // AX role
    expect(el.actions).toEqual(["press"]);
  });

  it("folds a VLM element overlapping the AX+OCR cluster into the same element", () => {
    const out = mergeScreenElements({
      ocr: [ocr("o1", "save", [10, 10, 40, 12])],
      ax: [ax("a1", "button", "Save", [11, 10, 40, 12])],
      vlm: [vlm("v1", "icon", "floppy disk save icon", [10, 11, 40, 12])],
    });
    expect(out).toHaveLength(1);
    expect((out[0] as GetScreenElement).groundingSources.sort()).toEqual([
      "ax",
      "ocr",
      "vlm",
    ]);
    expect((out[0] as GetScreenElement).text).toBe("Save"); // AX still wins
  });

  it("keeps non-overlapping elements from all three sources separate", () => {
    const out = mergeScreenElements({
      ocr: [ocr("o1", "Title", [0, 0, 50, 12])],
      ax: [ax("a1", "button", "OK", [0, 100, 30, 14])],
      vlm: [vlm("v1", "image", "a photo", [0, 200, 80, 80])],
    });
    expect(out).toHaveLength(3);
    expect(out.map((e) => e.groundingSources)).toEqual([
      ["ocr"],
      ["ax"],
      ["vlm"],
    ]);
  });

  it("degrades gracefully with no accessibility (OCR-only), never throwing", () => {
    expect(() => mergeScreenElements({})).not.toThrow();
    expect(mergeScreenElements({})).toEqual([]);
    const out = mergeScreenElements({
      ocr: [ocr("o1", "Hello", [0, 0, 30, 10])],
      ax: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.groundingSources).toEqual(["ocr"]);
  });

  it("produces deterministic top-to-bottom, left-to-right ordering regardless of input order", () => {
    const a = ocr("a", "A", [0, 0, 10, 10]);
    const b = ocr("b", "B", [100, 0, 10, 10]);
    const c = ocr("c", "C", [0, 100, 10, 10]);
    const order1 = mergeScreenElements({ ocr: [a, b, c] }).map((e) => e.text);
    const order2 = mergeScreenElements({ ocr: [c, b, a] }).map((e) => e.text);
    expect(order1).toEqual(["A", "B", "C"]);
    expect(order2).toEqual(order1);
  });

  it("respects the IoU threshold boundary (collapse only above it)", () => {
    // [0,0,10,10] vs [5,0,10,10] → IoU = 1/3 ≈ 0.333.
    const input = {
      ocr: [ocr("o1", "left", [0, 0, 10, 10])],
      ax: [ax("a1", "button", "Right", [5, 0, 10, 10])],
    };
    // threshold above the pair's IoU → stay separate (2 elements).
    expect(mergeScreenElements(input, { iouThreshold: 0.5 })).toHaveLength(2);
    // threshold below the pair's IoU → collapse (1 element).
    expect(mergeScreenElements(input, { iouThreshold: 0.3 })).toHaveLength(1);
  });

  it("never merges elements on different displays", () => {
    const out = mergeScreenElements({
      ocr: [ocr("o1", "same box", [0, 0, 10, 10], 0)],
      ax: [ax("a1", "button", "other display", [0, 0, 10, 10], ["press"], 1)],
    });
    expect(out).toHaveLength(2);
  });
});
