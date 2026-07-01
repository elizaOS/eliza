// @vitest-environment jsdom
//
// The pure, headless-safe part of panel-texture: greedy word-wrap. The actual
// canvas drawing (rasterizePanelToCanvas) needs a real 2D context — jsdom has
// none — so it is validated in the IWER browser PoC, where the rasterized canvas
// is uploaded to a WebGL texture and read back from the immersive framebuffer.

import { describe, expect, it } from "vitest";
import { wrapText } from "../panel-texture.ts";

// A deterministic stand-in for ctx.measureText: 10px per character.
const measure = (s: string) => s.length * 10;

describe("panel-texture — wrapText", () => {
  it("keeps a short line whole", () => {
    expect(wrapText("hi there", 1000, measure)).toEqual(["hi there"]);
  });

  it("wraps at word boundaries to fit the width", () => {
    // width 100px = 10 chars. Greedy: "alpha beta" (10) fits, "gamma" wraps.
    expect(wrapText("alpha beta gamma", 100, measure)).toEqual([
      "alpha beta",
      "gamma",
    ]);
  });

  it("emits an over-long word on its own line rather than dropping it", () => {
    expect(wrapText("supercalifragilistic ok", 80, measure)).toEqual([
      "supercalifragilistic",
      "ok",
    ]);
  });

  it("collapses whitespace and tolerates empty input", () => {
    expect(wrapText("   ", 100, measure)).toEqual([""]);
    expect(wrapText("a   b", 1000, measure)).toEqual(["a b"]);
  });
});
