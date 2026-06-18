/**
 * Framing linter for terminal renders.
 *
 * The engine guarantees each line is exactly `width` visible columns, but that
 * alone doesn't prove a render *looks* right: box borders must form closed,
 * column-aligned rectangles; verticals (│ ║) must stack in the same columns;
 * horizontal edges (─ ═) must run unbroken between corners; and content must
 * never poke through a border. This module checks all of that on the rendered
 * lines (after stripping ANSI) so tests and the review harness can assert a
 * render is structurally sound — not just width-correct.
 */

import { visibleWidth } from "@elizaos/tui";

const TL = new Set(["┌", "╭", "╔"]);
const TR = new Set(["┐", "╮", "╗"]);
const BL = new Set(["└", "╰", "╚"]);
const BR = new Set(["┘", "╯", "╝"]);
const HBORDER = new Set(["─", "═"]);
const VBORDER = new Set(["│", "║"]);

export interface FramingIssue {
  kind:
    | "width-mismatch"
    | "unclosed-box"
    | "misaligned-vertical"
    | "broken-top-edge"
    | "broken-bottom-edge"
    | "nested-box"
    | "truncated-affordance";
  row: number;
  col?: number;
  detail: string;
}

export interface FramingReport {
  width: number;
  height: number;
  /** Every line's visible width is equal (the contract). */
  uniformWidth: boolean;
  /** Number of complete box rectangles detected. */
  boxes: number;
  issues: FramingIssue[];
}

/** Strip ANSI SGR/OSC sequences, returning the visible glyph string. */
export function stripAnsi(line: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI ESC (\x1b) CSI sequences
  const csiPattern = /\x1b\[[0-9;?]*[A-Za-z]/g;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI OSC (\x1b ... \x07) sequences
  const oscPattern = /\x1b\][^\x07]*\x07/g;
  return line.replace(csiPattern, "").replace(oscPattern, "");
}

/**
 * Convert a visible string into an array of single-column cells, where a
 * double-width glyph occupies its cell followed by an empty continuation cell.
 * This makes column indices line up with terminal columns.
 */
function toCells(visible: string): string[] {
  const cells: string[] = [];
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const { segment } of seg.segment(visible)) {
    const w = visibleWidth(segment);
    cells.push(segment);
    for (let i = 1; i < w; i++) cells.push("");
  }
  return cells;
}

/** Analyse a block of rendered lines for framing integrity. */
export function analyzeFraming(lines: string[]): FramingReport {
  const issues: FramingIssue[] = [];
  const visibleLines = lines.map(stripAnsi);
  const widths = visibleLines.map((l) => visibleWidth(l));
  const width = widths.length ? Math.max(...widths) : 0;
  const uniformWidth = widths.every((w) => w === width);
  if (!uniformWidth) {
    widths.forEach((w, row) => {
      if (w !== width) {
        issues.push({
          kind: "width-mismatch",
          row,
          detail: `line width ${w} != block width ${width}`,
        });
      }
    });
  }

  // Build a column grid (rows × cols of single-column cells).
  const grid = visibleLines.map(toCells);
  const at = (r: number, c: number): string =>
    r >= 0 && r < grid.length && c >= 0 && c < grid[r].length ? grid[r][c] : "";

  // Detect boxes by their top-left corners and validate the rectangle.
  let boxes = 0;
  const rects: Array<{ r: number; c: number; br: number; rc: number }> = [];
  const counted = new Set<string>();
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      if (!TL.has(at(r, c))) continue;
      // The top edge starts with a rule, may carry a title in the middle
      // (`╭─ Title ───╮`), and ends with a rule before the top-right corner.
      if (!HBORDER.has(at(r, c + 1))) continue;
      let rc = c + 2;
      while (rc < grid[r].length && !TR.has(at(r, rc))) rc++;
      if (rc >= grid[r].length || !TR.has(at(r, rc))) continue; // no top-right
      if (!HBORDER.has(at(r, rc - 1))) continue; // top edge must end with a rule
      // Find the bottom edge: scan down the left column for a BL corner.
      let br = r + 1;
      while (br < grid.length && VBORDER.has(at(br, c))) br++;
      if (!BL.has(at(br, c))) {
        issues.push({
          kind: "unclosed-box",
          row: r,
          col: c,
          detail: `top-left at (${r},${c}) has no closing bottom-left in column ${c}`,
        });
        continue;
      }
      const key = `${r},${c},${br},${rc}`;
      if (counted.has(key)) continue;
      counted.add(key);

      // Validate bottom-right corner + bottom edge run.
      if (!BR.has(at(br, rc))) {
        issues.push({
          kind: "broken-bottom-edge",
          row: br,
          col: rc,
          detail: `bottom-right corner missing at (${br},${rc})`,
        });
      }
      for (let cc = c + 1; cc < rc; cc++) {
        if (!HBORDER.has(at(br, cc))) {
          issues.push({
            kind: "broken-bottom-edge",
            row: br,
            col: cc,
            detail: `bottom edge broken at (${br},${cc}): "${at(br, cc) || " "}"`,
          });
          break;
        }
      }
      // Validate the two vertical edges align in their columns for every inner row.
      for (let rr = r + 1; rr < br; rr++) {
        if (!VBORDER.has(at(rr, c))) {
          issues.push({
            kind: "misaligned-vertical",
            row: rr,
            col: c,
            detail: `left border missing at (${rr},${c}): "${at(rr, c) || " "}"`,
          });
        }
        if (!VBORDER.has(at(rr, rc))) {
          issues.push({
            kind: "misaligned-vertical",
            row: rr,
            col: rc,
            detail: `right border missing at (${rr},${rc}): "${at(rr, rc) || " "}"`,
          });
        }
        // Note: a separate "content past the right border" scan is intentionally
        // omitted — sibling boxes legitimately occupy columns to the right, and a
        // real overflow already shows up as a missing right border (above) or a
        // width mismatch. Checking raw columns would false-positive on siblings.
      }
      boxes++;
      rects.push({ r, c, br, rc });
    }
  }

  // Detect truncated buttons: a button renders as `[ label ]`; when a row is
  // over budget it gets shrunk and the closing ` ]` is cut, leaving `[ label`.
  // An unbalanced count of `[ ` openers vs ` ]` closers on a line flags it.
  visibleLines.forEach((line, row) => {
    const opens = (line.match(/\[ /g) ?? []).length;
    const closes = (line.match(/ \]/g) ?? []).length;
    if (opens > closes) {
      issues.push({
        kind: "truncated-affordance",
        row,
        detail: `line has ${opens} "[ " openers but ${closes} " ]" closers — a button is cut off`,
      });
    }
  });

  // Minimise framing: flag any box fully contained inside another (nesting).
  // A single outer frame per view is the house style; sections use dividers.
  for (const inner of rects) {
    const parent = rects.find(
      (o) =>
        o !== inner &&
        o.r < inner.r &&
        o.c < inner.c &&
        o.br > inner.br &&
        o.rc > inner.rc,
    );
    if (parent) {
      issues.push({
        kind: "nested-box",
        row: inner.r,
        col: inner.c,
        detail: `box (${inner.r},${inner.c})-(${inner.br},${inner.rc}) is nested inside (${parent.r},${parent.c})-(${parent.br},${parent.rc}); use a divider instead`,
      });
    }
  }

  return { width, height: lines.length, uniformWidth, boxes, issues };
}

/** A one-line column ruler for eyeballing alignment in a text export. */
export function columnRuler(width: number): string {
  let tens = "";
  let ones = "";
  for (let i = 0; i < width; i++) {
    ones += String(i % 10);
    tens += i % 10 === 0 ? String(Math.floor(i / 10) % 10) : " ";
  }
  return `${tens}\n${ones}`;
}
