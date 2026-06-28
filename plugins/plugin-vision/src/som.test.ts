/**
 * Set-of-Marks (SoM) grounding tests — #9170 M9.
 *
 * The fusion core is pure, so the suppression / NMS / numbering rules are
 * asserted directly. The overlay renderer is exercised against `sharp` with a
 * tiny synthetic PNG (no screen capture needed).
 */

import { describe, expect, it } from "vitest";
import {
  buildSceneSetOfMarks,
  buildSetOfMarks,
  buildSetOfMarksSvg,
  coverageRatio,
  renderSetOfMarksOverlay,
  type SomCandidate,
  somCandidatesFromDetections,
  somCandidatesFromOcr,
} from "./som.js";

describe("coverageRatio", () => {
  it("is 1 when inner is fully inside outer", () => {
    expect(coverageRatio([10, 10, 10, 10], [0, 0, 100, 100])).toBe(1);
  });
  it("is 0 when disjoint", () => {
    expect(coverageRatio([0, 0, 10, 10], [50, 50, 10, 10])).toBe(0);
  });
  it("is the covered fraction on partial overlap", () => {
    // 20x20 text, half its width covered by the icon → 0.5.
    expect(coverageRatio([0, 0, 20, 20], [10, 0, 100, 20])).toBeCloseTo(0.5, 5);
  });
  it("is 0 for a degenerate (zero-area) inner box", () => {
    expect(coverageRatio([0, 0, 0, 10], [0, 0, 100, 100])).toBe(0);
  });
});

describe("buildSetOfMarks — fusion rules", () => {
  it("suppresses text mostly covered by an icon (icon-over-text)", () => {
    const candidates: SomCandidate[] = [
      { bbox: [0, 0, 40, 40], source: "icon", label: "button", score: 0.9 },
      // Text sitting fully inside the icon → dropped.
      { bbox: [5, 5, 20, 10], source: "text", label: "OK", score: 0.8 },
      // Standalone text elsewhere → kept.
      { bbox: [200, 200, 60, 16], source: "text", label: "far", score: 0.8 },
    ];
    const marks = buildSetOfMarks(candidates);
    expect(marks).toHaveLength(2);
    expect(marks.some((m) => m.source === "icon")).toBe(true);
    expect(marks.some((m) => m.label === "far")).toBe(true);
    expect(marks.some((m) => m.label === "OK")).toBe(false);
  });

  it("collapses overlapping boxes via NMS, keeping the icon over the text", () => {
    const candidates: SomCandidate[] = [
      { bbox: [0, 0, 50, 50], source: "icon", score: 0.6 },
      // Heavily overlapping text (IoU > 0.5) but NOT covered enough to be
      // suppressed by icon-over-text — NMS should still collapse it.
      { bbox: [3, 3, 50, 50], source: "text", score: 0.95 },
    ];
    const marks = buildSetOfMarks(candidates, { iconOverTextCoverage: 0.99 });
    expect(marks).toHaveLength(1);
    expect(marks[0]?.source).toBe("icon");
  });

  it("numbers marks 1-indexed in reading order (rows top-down, left-right)", () => {
    const candidates: SomCandidate[] = [
      { bbox: [300, 0, 20, 20], source: "icon" }, // row 0, right
      { bbox: [0, 0, 20, 20], source: "icon" }, // row 0, left
      { bbox: [0, 100, 20, 20], source: "icon" }, // row 1, left
    ];
    const marks = buildSetOfMarks(candidates);
    expect(marks.map((m) => m.index)).toEqual([1, 2, 3]);
    // First mark is the top-left, last is the lower row.
    expect(marks[0]?.bbox).toEqual([0, 0, 20, 20]);
    expect(marks[1]?.bbox).toEqual([300, 0, 20, 20]);
    expect(marks[2]?.bbox).toEqual([0, 100, 20, 20]);
  });

  it("is deterministic regardless of input ordering", () => {
    const a: SomCandidate[] = [
      { bbox: [0, 0, 20, 20], source: "icon", score: 0.5 },
      { bbox: [100, 0, 20, 20], source: "text", score: 0.7 },
      { bbox: [0, 80, 20, 20], source: "icon", score: 0.6 },
    ];
    const reversed = [...a].reverse();
    expect(buildSetOfMarks(a)).toEqual(buildSetOfMarks(reversed));
  });

  it("drops degenerate (non-finite / zero-area) boxes", () => {
    const candidates: SomCandidate[] = [
      { bbox: [0, 0, 0, 10], source: "icon" },
      { bbox: [Number.NaN, 0, 10, 10], source: "icon" },
      { bbox: [10, 10, 20, 20], source: "icon" },
    ];
    const marks = buildSetOfMarks(candidates);
    expect(marks).toHaveLength(1);
    expect(marks[0]?.bbox).toEqual([10, 10, 20, 20]);
  });

  it("honors minScore filtering", () => {
    const candidates: SomCandidate[] = [
      { bbox: [0, 0, 20, 20], source: "icon", score: 0.2 },
      { bbox: [100, 0, 20, 20], source: "icon", score: 0.8 },
    ];
    expect(buildSetOfMarks(candidates, { minScore: 0.5 })).toHaveLength(1);
  });

  it("computes the center for the click target", () => {
    const marks = buildSetOfMarks([{ bbox: [10, 20, 40, 60], source: "icon" }]);
    expect(marks[0]?.center).toEqual([30, 50]);
  });
});

describe("source adapters", () => {
  it("somCandidatesFromDetections maps YOLO boxes to icon candidates", () => {
    const cands = somCandidatesFromDetections([
      {
        boundingBox: { x: 1, y: 2, width: 3, height: 4 },
        type: "icon",
        confidence: 0.7,
      },
    ]);
    expect(cands).toEqual([
      { bbox: [1, 2, 3, 4], source: "icon", score: 0.7, label: "icon" },
    ]);
  });

  it("somCandidatesFromOcr maps OCR blocks to text candidates", () => {
    const cands = somCandidatesFromOcr([
      {
        bbox: { x: 5, y: 6, width: 7, height: 8 },
        text: "hello",
        confidence: 0.9,
      },
    ]);
    expect(cands).toEqual([
      { bbox: [5, 6, 7, 8], source: "text", score: 0.9, label: "hello" },
    ]);
  });

  it("buildSceneSetOfMarks fuses both sources", () => {
    const marks = buildSceneSetOfMarks({
      detections: [
        { boundingBox: { x: 0, y: 0, width: 30, height: 30 }, confidence: 0.8 },
      ],
      ocrBlocks: [
        { bbox: { x: 200, y: 0, width: 60, height: 16 }, text: "label" },
      ],
    });
    expect(marks).toHaveLength(2);
    expect(marks.map((m) => m.source).sort()).toEqual(["icon", "text"]);
  });
});

describe("buildSetOfMarksSvg", () => {
  it("emits one rect + badge + numbered text per mark, clamped to canvas", () => {
    const marks = buildSetOfMarks([
      { bbox: [10, 10, 40, 40], source: "icon" },
      { bbox: [100, 100, 40, 40], source: "text" },
    ]);
    const svg = buildSetOfMarksSvg(marks, 640, 480);
    expect(svg).toContain('width="640"');
    expect(svg).toContain('height="480"');
    // Two box outlines + two badges → 4 rects.
    expect(svg.match(/<rect /g) ?? []).toHaveLength(4);
    // 1-indexed numbers present.
    expect(svg).toContain(">1</text>");
    expect(svg).toContain(">2</text>");
  });

  it("escapes nothing unsafe in numeric labels (numbers only)", () => {
    const marks = buildSetOfMarks([{ bbox: [0, 0, 10, 10], source: "icon" }]);
    const svg = buildSetOfMarksSvg(marks, 100, 100);
    expect(svg).not.toContain("undefined");
  });
});

describe("renderSetOfMarksOverlay", () => {
  it("composites the overlay onto a real PNG and returns same-size PNG bytes", async () => {
    const sharp = (await import("sharp")).default;
    const base = await sharp({
      create: {
        width: 200,
        height: 120,
        channels: 3,
        background: { r: 20, g: 20, b: 20 },
      },
    })
      .png()
      .toBuffer();

    const marks = buildSetOfMarks([
      { bbox: [10, 10, 50, 30], source: "icon" },
      { bbox: [100, 60, 60, 20], source: "text" },
    ]);
    const out = await renderSetOfMarksOverlay(base, marks);
    expect(out.length).toBeGreaterThan(0);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(120);
    expect(meta.format).toBe("png");
  });

  it("throws on an image with no dimensions", async () => {
    await expect(
      renderSetOfMarksOverlay(new Uint8Array([1, 2, 3]), []),
    ).rejects.toThrow();
  });
});
