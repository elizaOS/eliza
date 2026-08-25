// Covers the Code example help overlay: frame geometry, fill-to-height,
// section ordering, narrow-width padding clamps, and deterministic re-render.
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@elizaos/tui";
import { describe, expect, test } from "vitest";
import { VirtualTerminal } from "../testing/virtual-terminal.test.js";
import { HelpOverlay } from "./HelpOverlay.js";

function makeOverlay(cols: number, rows: number) {
  const terminal = new VirtualTerminal(cols, rows);
  return { terminal, overlay: new HelpOverlay(terminal) };
}

function plainLines(lines: string[]): string[] {
  return lines.map((line) => stripVTControlCharacters(line));
}

function borderDashCount(line: string): number {
  const match = line.match(/[╭╰](─*)[╮╯]/);
  expect(match).not.toBeNull();
  return match?.[1].length ?? 0;
}

describe("HelpOverlay", () => {
  test("draws a closed rounded frame sized from the requested width", () => {
    const WIDTH = 80;
    const { overlay } = makeOverlay(WIDTH, 24);
    const lines = plainLines(overlay.render(WIDTH));

    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toMatch(/^ ╭─+╮$/);
    expect(lines[lines.length - 1]).toMatch(/^ ╰─+╯$/);
    // innerWidth is width - 4, and both horizontal borders use it verbatim.
    expect(borderDashCount(lines[0])).toBe(WIDTH - 4);
    expect(borderDashCount(lines[lines.length - 1])).toBe(WIDTH - 4);
  });

  test("fills the frame to the terminal height and pins the close hint above the bottom border", () => {
    const WIDTH = 80;
    const ROWS = 40;
    const { overlay } = makeOverlay(WIDTH, ROWS);
    const lines = plainLines(overlay.render(WIDTH));

    expect(lines.length).toBe(ROWS);
    expect(lines[lines.length - 1]).toMatch(/^ ╰─+╯$/);
    expect(lines[lines.length - 2]).toContain("Press ? or Esc to close");
    // The filler between the last command block and the close hint is blank.
    const filler = plainLines(overlay.render(WIDTH)).slice(
      24,
      lines.length - 2,
    );
    expect(filler.length).toBeGreaterThan(0);
    for (const line of filler) {
      expect(line).toMatch(/^ │\s+│$/);
    }
  });

  test("renders taller than a short terminal rather than truncating the fixed content", () => {
    const { overlay } = makeOverlay(80, 3);
    const lines = plainLines(overlay.render(80));

    expect(lines[0]).toMatch(/^ ╭─+╮$/);
    expect(lines[lines.length - 1]).toMatch(/^ ╰─+╯$/);
    expect(lines.join("\n")).toContain("Press ? or Esc to close");
  });

  test("renders every section, shortcut entry, and the close hint in document order", () => {
    const { overlay } = makeOverlay(100, 40);
    const rendered = plainLines(overlay.render(100)).join("\n");

    for (const needle of [
      "Help",
      "Navigation",
      "Tab: switch panes (except while typing /command)",
      "Ctrl+< / Ctrl+> (or Ctrl+, / Ctrl+.): resize tasks pane",
      "?: toggle help",
      "Ctrl+N: new conversation",
      "Ctrl+C / Ctrl+Q: quit",
      "Chat",
      "Enter: send | PgUp/PgDn/Home/End: scroll | Esc: clear",
      "/help: show commands",
      "Tasks",
      "↑↓ select | Enter switch | d done/open | f finished | e edit mode",
      "Edit mode: r rename | p pause/resume | c cancel | x delete (y/n confirm)",
      "/task pane show|hide|auto|toggle",
      "Commands",
      "/new, /switch, /rename, /delete, /reset",
      "/task, /tasks, /cd, /pwd, /clear",
      "Press ? or Esc to close",
    ]) {
      expect(rendered).toContain(needle);
    }

    let cursor = -1;
    for (const needle of [
      "Help",
      "Navigation",
      "Tab: switch panes",
      "Ctrl+C / Ctrl+Q: quit",
      "Chat",
      "/help: show commands",
      "Tasks",
      "Edit mode: r rename",
      "Commands",
      "/new, /switch, /rename, /delete, /reset",
      "Press ? or Esc to close",
    ]) {
      const found = rendered.indexOf(needle, cursor + 1);
      expect(found).toBeGreaterThan(cursor);
      cursor = found;
    }
  });

  test("keeps every line inside the terminal across realistic widths", () => {
    for (const width of [80, 100, 120]) {
      const { overlay } = makeOverlay(width, 24);
      const lines = overlay.render(width);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
      expect(borderDashCount(stripVTControlCharacters(lines[0]))).toBe(
        width - 4,
      );
    }
  });

  test("clamps inter-column padding to zero instead of going negative on narrow terminals", () => {
    // At cockpit phone width several fixed labels exceed innerWidth; the
    // guarded repeats clamp to zero so the frame still renders (MainScreen
    // owns clipping, see narrow-terminal.test.ts).
    const WIDTH = 43;
    const { overlay } = makeOverlay(WIDTH, 24);

    let lines: string[] = [];
    expect(() => {
      lines = plainLines(overlay.render(WIDTH));
    }).not.toThrow();

    expect(lines[0]).toMatch(/^ ╭─+╮$/);
    expect(borderDashCount(lines[0])).toBe(WIDTH - 4);
    expect(lines.join("\n")).toContain("?: toggle help");
    expect(lines.join("\n")).toContain("Commands");
  });

  test("is deterministic across renders and invalidate() stays a no-op", () => {
    const { overlay } = makeOverlay(90, 30);
    const first = overlay.render(90);
    overlay.invalidate();
    expect(overlay.invalidate()).toBeUndefined();
    const second = overlay.render(90);

    expect(second).toEqual(first);
    expect(second.length).toBe(30);
  });
});
