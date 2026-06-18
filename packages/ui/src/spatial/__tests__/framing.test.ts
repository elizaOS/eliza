import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { GALLERY } from "../gallery.tsx";
import { analyzeFraming } from "../tui/framing.ts";
import { renderViewToLines } from "../tui/index.ts";

const WIDTHS = [56, 40, 28];

describe("tui framing — every gallery render frames cleanly", () => {
  for (const screen of GALLERY) {
    for (const width of WIDTHS) {
      it(`${screen.id} @ ${width}: uniform width, no framing issues`, () => {
        const lines = renderViewToLines(createElement(screen.view), width);
        const report = analyzeFraming(lines);
        expect(report.width).toBe(width);
        expect(report.uniformWidth).toBe(true);
        // Surface the first issue in the failure message for fast diagnosis.
        expect(
          report.issues.map((i) => `${i.kind}@${i.row},${i.col}: ${i.detail}`),
        ).toEqual([]);
      });
    }
  }
});

describe("tui framing — linter catches real breakage", () => {
  it("flags an unclosed box (missing bottom edge)", () => {
    const broken = [
      "╭────╮", //
      "│ hi │",
      "      ", // bottom edge missing
    ];
    const report = analyzeFraming(broken);
    expect(report.issues.some((i) => i.kind === "unclosed-box")).toBe(true);
  });

  it("flags a misaligned vertical (right border shifted)", () => {
    const broken = [
      "╭────╮",
      "│ hi│ ", // right border one column left of the corner
      "╰────╯",
    ];
    const report = analyzeFraming(broken);
    expect(report.issues.some((i) => i.kind === "misaligned-vertical")).toBe(
      true,
    );
  });

  it("flags a width mismatch", () => {
    const report = analyzeFraming(["aaaa", "bb", "cccc"]);
    expect(report.uniformWidth).toBe(false);
    expect(report.issues.some((i) => i.kind === "width-mismatch")).toBe(true);
  });

  it("passes a correct nested-box layout (sibling boxes are fine)", () => {
    const ok = [
      "╭──────────────╮",
      "│ ╭──╮  ╭──╮   │",
      "│ │a │  │b │   │",
      "│ ╰──╯  ╰──╯   │",
      "╰──────────────╯",
    ];
    const report = analyzeFraming(ok);
    expect(report.issues).toEqual([]);
    expect(report.boxes).toBe(3);
  });
});
