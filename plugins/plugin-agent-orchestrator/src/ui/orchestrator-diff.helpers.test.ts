// Coverage for the pure LCS line-diff used by the tool-call file-change cards.
// A diff bug shows the operator the wrong edit, so the alignment + line
// numbering + the large-input flat fallback are pinned here.

import { describe, expect, it } from "vitest";
import { countDiff, lineDiff } from "./orchestrator-diff.helpers";

describe("lineDiff", () => {
  it("renders identical text as all-context with no add/remove", () => {
    const rows = lineDiff("a\nb\nc", "a\nb\nc");
    expect(rows.map((r) => r.type)).toEqual(["context", "context", "context"]);
    expect(countDiff(rows)).toEqual({ added: 0, removed: 0 });
  });

  it("aligns a pure insertion as context + add", () => {
    const rows = lineDiff("a\nc", "a\nb\nc");
    expect(rows.map((r) => r.type)).toEqual(["context", "add", "context"]);
    expect(countDiff(rows)).toEqual({ added: 1, removed: 0 });
  });

  it("aligns a pure deletion as context + remove", () => {
    const rows = lineDiff("a\nb\nc", "a\nc");
    expect(rows.map((r) => r.type)).toEqual(["context", "remove", "context"]);
    expect(countDiff(rows)).toEqual({ added: 0, removed: 1 });
  });

  it("renders a changed line as remove-then-add with correct 1-based numbering", () => {
    const rows = lineDiff("a\nX\nc", "a\nY\nc");
    expect(rows).toEqual([
      { type: "context", oldLine: 1, newLine: 1, text: "a" },
      { type: "remove", oldLine: 2, newLine: null, text: "X" },
      { type: "add", oldLine: null, newLine: 2, text: "Y" },
      { type: "context", oldLine: 3, newLine: 3, text: "c" },
    ]);
    expect(countDiff(rows)).toEqual({ added: 1, removed: 1 });
  });

  it("falls back to a flat remove-then-add above the alignment cap", () => {
    const oldText = Array.from({ length: 401 }, (_, i) => `o${i}`).join("\n");
    const newText = Array.from({ length: 401 }, (_, i) => `n${i}`).join("\n");
    const rows = lineDiff(oldText, newText); // 802 lines > MAX_ALIGN_LINES (800)
    expect(rows.some((r) => r.type === "context")).toBe(false);
    expect(rows[0].type).toBe("remove");
    expect(rows[rows.length - 1].type).toBe("add");
    expect(countDiff(rows)).toEqual({ added: 401, removed: 401 });
  });
});

describe("countDiff", () => {
  it("counts add/remove rows and ignores context", () => {
    expect(countDiff([])).toEqual({ added: 0, removed: 0 });
    expect(
      countDiff([
        { type: "add", oldLine: null, newLine: 1, text: "x" },
        { type: "context", oldLine: 1, newLine: 2, text: "y" },
        { type: "remove", oldLine: 2, newLine: null, text: "z" },
      ]),
    ).toEqual({ added: 1, removed: 1 });
  });
});
