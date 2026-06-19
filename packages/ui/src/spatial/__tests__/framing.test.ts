import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { GALLERY } from "../gallery.tsx";
import { analyzeFraming } from "../tui/framing.ts";
import { renderViewToLines } from "../tui/index.ts";

// Realistic terminal panel widths. Below ~40 columns long button labels
// legitimately can't fit; the agent terminal renders views at full width.
const WIDTHS = [56, 40];

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

  it("passes pure sibling boxes (no containing frame)", () => {
    const ok = ["╭──╮  ╭──╮", "│a │  │b │", "╰──╯  ╰──╯"];
    const report = analyzeFraming(ok);
    expect(report.issues).toEqual([]);
    expect(report.boxes).toBe(2);
  });

  it("flags a box nested inside another (minimise framing)", () => {
    const nested = [
      "╭──────────────╮",
      "│ ╭──╮  ╭──╮   │",
      "│ │a │  │b │   │",
      "│ ╰──╯  ╰──╯   │",
      "╰──────────────╯",
    ];
    const report = analyzeFraming(nested);
    expect(report.issues.filter((i) => i.kind === "nested-box")).toHaveLength(
      2,
    );
  });

  it("detects a titled outer frame (╭─ Title ─╮)", () => {
    const titled = ["╭─ Hi ─╮", "│ body │", "╰──────╯"];
    const report = analyzeFraming(titled);
    expect(report.boxes).toBe(1);
    expect(report.issues).toEqual([]);
  });

  it("flags a truncated button (cut-off ` ]`)", () => {
    const report = analyzeFraming(["[ Refresh ] [ Conf"]);
    expect(report.issues.some((i) => i.kind === "truncated-affordance")).toBe(
      true,
    );
  });
});
