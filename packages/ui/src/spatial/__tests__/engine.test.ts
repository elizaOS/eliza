/**
 * Unit coverage for the TUI layout engine: node measurement and the fixed-width
 * line contract. Pure, no live terminal.
 */
import { visibleWidth } from "@elizaos/tui";
import { describe, expect, it } from "vitest";
import type { SpatialBoxNode, SpatialTextNode } from "../ir.ts";
import { measureWidth, renderSpatialNode } from "../tui/index.ts";

/** Assert every line is exactly `width` visible columns (the TUI line contract). */
function expectWidth(lines: string[], width: number): void {
  for (const line of lines) expect(visibleWidth(line)).toBe(width);
}

const text = (
  value: string,
  extra: Partial<SpatialTextNode> = {},
): SpatialTextNode => ({
  type: "text",
  value,
  ...extra,
});

describe("tui engine — leaf rendering", () => {
  it("renders plain body text padded to width with no ANSI", () => {
    const lines = renderSpatialNode(text("hello"), 10);
    expect(lines).toEqual(["hello     "]);
  });

  it("wraps text across lines, each exactly width", () => {
    const lines = renderSpatialNode(text("the quick brown fox"), 9);
    expect(lines.length).toBeGreaterThan(1);
    expectWidth(lines, 9);
    expect(lines.join("\n")).toContain("quick");
  });

  it("truncates with an ellipsis when wrap is disabled", () => {
    const lines = renderSpatialNode(text("abcdefghij", { wrap: false }), 5);
    expect(lines.length).toBe(1);
    expect(visibleWidth(lines[0])).toBe(5);
    expect(lines[0]).toContain("…");
  });

  it("renders a full-width divider", () => {
    const lines = renderSpatialNode({ type: "divider" }, 6);
    expect(lines.length).toBe(1);
    expect(visibleWidth(lines[0])).toBe(6);
    expect(lines[0]).toContain("─");
  });
});

describe("tui engine — column layout", () => {
  it("stacks children with vertical gap", () => {
    const node: SpatialBoxNode = {
      type: "box",
      direction: "column",
      gap: 1,
      children: [text("a"), text("b")],
    };
    const lines = renderSpatialNode(node, 4);
    expect(lines).toEqual(["a   ", "    ", "b   "]);
  });

  it("honours horizontal alignment within the column", () => {
    const node: SpatialBoxNode = {
      type: "box",
      direction: "column",
      gap: 0,
      align: "center",
      children: [text("hi")],
    };
    const lines = renderSpatialNode(node, 6);
    expect(lines).toEqual(["  hi  "]);
  });
});

describe("tui engine — row layout + grow", () => {
  it("distributes free space to a growing child, pushing siblings to the edge", () => {
    const node: SpatialBoxNode = {
      type: "box",
      direction: "row",
      gap: 0,
      children: [text("L", { grow: 1 }), text("R")],
    };
    const lines = renderSpatialNode(node, 10);
    expect(lines.length).toBe(1);
    expect(visibleWidth(lines[0])).toBe(10);
    // "L" grows to fill, "R" sits at the right edge.
    expect(lines[0]).toBe("L        R");
  });

  it("places fixed-width columns side by side with a gap", () => {
    const node: SpatialBoxNode = {
      type: "box",
      direction: "row",
      gap: 1,
      children: [text("ab", { width: 2 }), text("cd", { width: 2 })],
    };
    const lines = renderSpatialNode(node, 8);
    expect(lines[0]).toBe("ab cd   ");
  });

  it("wraps row children to a new line when over budget", () => {
    const node: SpatialBoxNode = {
      type: "box",
      direction: "row",
      gap: 1,
      wrap: true,
      children: [text("aaaa"), text("bbbb"), text("cccc")],
    };
    const lines = renderSpatialNode(node, 9);
    expectWidth(lines, 9);
    expect(lines.length).toBeGreaterThan(1);
  });
});

describe("tui engine — borders + padding", () => {
  it("frames a bordered box and keeps every line at the target width", () => {
    const node: SpatialBoxNode = {
      type: "box",
      direction: "column",
      gap: 0,
      border: "round",
      padding: 0,
      children: [text("x")],
    };
    const lines = renderSpatialNode(node, 5);
    expectWidth(lines, 5);
    expect(lines[0]).toBe("╭───╮");
    expect(lines[lines.length - 1]).toBe("╰───╯");
    expect(lines[1]).toContain("x");
  });

  it("embeds a title in the top border", () => {
    const node: SpatialBoxNode = {
      type: "box",
      direction: "column",
      gap: 0,
      border: "single",
      title: "Hi",
      children: [text("y")],
    };
    const lines = renderSpatialNode(node, 10);
    expect(lines[0]).toContain("Hi");
    expect(visibleWidth(lines[0])).toBe(10);
  });
});

describe("tui engine — measurement", () => {
  it("measures natural widths, capped by the constraint", () => {
    expect(measureWidth(text("hello"), 100)).toBe(5);
    expect(measureWidth(text("hello"), 3)).toBe(3);
    expect(measureWidth({ type: "button", label: "Go" }, 100)).toBe(6); // "[ Go ]"
  });
});
