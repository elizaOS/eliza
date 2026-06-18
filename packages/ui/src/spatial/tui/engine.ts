/**
 * Terminal layout + paint engine — the third renderer.
 *
 * GUI and XR hand the authored React tree to the browser's flexbox. The terminal
 * has none, so this engine *is* the flexbox: it lays out the modality-agnostic
 * {@link SpatialNode} tree (the same one GUI/XR render) into terminal lines.
 *
 * It composes "blocks" (a `string[]` of fixed visible width) bottom-up, à la
 * Ink's static renderer — each node renders to a block of an exact width, and
 * containers tile their children's blocks along the main axis with gap, padding,
 * border and grow distribution. Width measurement and ANSI-safe truncation reuse
 * `@elizaos/tui` so wide (CJK/emoji) glyphs and styled text stay aligned.
 *
 * Output contract: `render(node, width)` returns lines each EXACTLY `width`
 * visible columns, with every styled segment self-closing (`…\x1b[0m`) so colour
 * never bleeds into padding — which is what `@elizaos/tui` expects from a line.
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@elizaos/tui";
import {
  resolvePadding,
  type SpatialBorder,
  type SpatialBoxNode,
  type SpatialButtonNode,
  type SpatialDividerNode,
  type SpatialFieldNode,
  type SpatialImageNode,
  type SpatialLength,
  type SpatialNode,
  type SpatialSpacerNode,
  type SpatialTextNode,
  type SpatialTone,
} from "../ir.ts";

// --- ANSI styling -----------------------------------------------------------

/** Agent id of the keyboard-focused control, highlighted on render. */
let focusedAgentId: string | null = null;
/** Set the focused control before a render pass (terminal keyboard focus). */
export function setFocusedAgentId(id: string | null): void {
  focusedAgentId = id;
}

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

function sgr(text: string, codes: number[]): string {
  if (codes.length === 0 || text.length === 0) return text;
  return `${ESC}${codes.join(";")}m${text}${RESET}`;
}

const TONE_FG: Record<SpatialTone, number | null> = {
  default: null,
  muted: 90, // bright black / grey
  primary: 33, // yellow ≈ brand orange in a 16-colour terminal
  success: 32,
  warning: 33,
  danger: 31,
};

function toneCodes(tone: SpatialTone | undefined): number[] {
  if (!tone) return [];
  const code = TONE_FG[tone];
  return code === null ? [] : [code];
}

// --- Line helpers -----------------------------------------------------------

function blank(width: number): string {
  return width > 0 ? " ".repeat(width) : "";
}

/** Force a (possibly styled) line to exactly `width` visible columns. */
function fitWidth(line: string, width: number): string {
  if (width <= 0) return "";
  const w = visibleWidth(line);
  if (w === width) return line;
  if (w < width) return line + blank(width - w);
  const truncated = truncateToWidth(line, width, "", false);
  const tw = visibleWidth(truncated);
  return tw < width ? truncated + blank(width - tw) : truncated;
}

/** Place a content line within a wider field, honouring horizontal alignment. */
function alignH(
  line: string,
  width: number,
  align: "start" | "center" | "end",
): string {
  const w = Math.min(visibleWidth(line), width);
  const free = Math.max(0, width - w);
  if (align === "center") {
    const left = Math.floor(free / 2);
    return fitWidth(blank(left) + line, width);
  }
  if (align === "end") {
    return fitWidth(blank(free) + line, width);
  }
  return fitWidth(line, width);
}

/** Pad a block (array of equal-width lines) vertically to `height`. */
function padBlockV(
  lines: string[],
  width: number,
  height: number,
  align: "start" | "center" | "end" | "stretch",
): string[] {
  if (lines.length >= height) return lines.slice(0, height);
  const free = height - lines.length;
  const top =
    align === "center" ? Math.floor(free / 2) : align === "end" ? free : 0;
  const bottom = free - top;
  return [
    ...Array.from({ length: top }, () => blank(width)),
    ...lines,
    ...Array.from({ length: bottom }, () => blank(width)),
  ];
}

// --- Length resolution ------------------------------------------------------

function resolveLength(
  value: SpatialLength | undefined,
  available: number,
): number | null {
  if (value === undefined || value === "auto") return null;
  if (typeof value === "number") return Math.max(0, Math.min(value, available));
  const pct = Number.parseFloat(value);
  if (Number.isNaN(pct)) return null;
  return Math.max(0, Math.min(Math.round((pct / 100) * available), available));
}

function borderSize(border: SpatialBorder | undefined): number {
  return border && border !== "none" ? 1 : 0;
}

function insets(node: SpatialNode): {
  t: number;
  r: number;
  b: number;
  l: number;
} {
  if (node.type !== "box") return { t: 0, r: 0, b: 0, l: 0 };
  const bw = borderSize(node.border);
  const p = resolvePadding(node.padding);
  return { t: bw + p.top, r: bw + p.right, b: bw + p.bottom, l: bw + p.left };
}

// --- Natural width measurement ----------------------------------------------

/** Intrinsic main-cross-independent width of a node, capped at `maxW`. */
export function measureWidth(node: SpatialNode, maxW: number): number {
  if (maxW <= 0) return 0;
  const explicit = resolveLength(node.width, maxW);
  if (explicit !== null) return explicit;

  switch (node.type) {
    case "text":
      return Math.min(visibleWidth(node.value), maxW);
    case "button":
      return Math.min(visibleWidth(node.label) + 4, maxW);
    case "field": {
      const label = node.label ? visibleWidth(node.label) : 0;
      const body = visibleWidth(node.value || node.placeholder || "") + 2;
      return Math.min(Math.max(label, body, 8), maxW);
    }
    case "divider":
      return node.orientation === "vertical" ? 1 : maxW;
    case "spacer":
      return node.size ?? 0;
    case "image":
      return Math.min(visibleWidth(`[${node.alt || "image"}]`), maxW);
    case "box":
      return measureBoxWidth(node, maxW);
  }
}

function measureBoxWidth(node: SpatialBoxNode, maxW: number): number {
  const ins = insets(node);
  const innerMax = Math.max(0, maxW - ins.l - ins.r);
  const kids = node.children;
  if (kids.length === 0) return Math.min(ins.l + ins.r, maxW);

  if (node.direction === "row") {
    let sum = 0;
    for (const k of kids) sum += measureWidth(k, innerMax);
    sum += node.gap * (kids.length - 1);
    return Math.min(sum + ins.l + ins.r, maxW);
  }
  // column: width is the widest child
  let widest = 0;
  for (const k of kids) widest = Math.max(widest, measureWidth(k, innerMax));
  if (node.title) widest = Math.max(widest, visibleWidth(node.title));
  return Math.min(widest + ins.l + ins.r, maxW);
}

// --- Render -----------------------------------------------------------------

/**
 * Render a node into a block of lines, each exactly `width` visible columns.
 * Height is content-driven unless the node declares a numeric `height`.
 */
export function render(node: SpatialNode, width: number): string[] {
  if (width <= 0) return [];
  switch (node.type) {
    case "text":
      return renderText(node, width);
    case "button":
      return renderButton(node, width);
    case "field":
      return renderField(node, width);
    case "divider":
      return renderDivider(node, width);
    case "spacer":
      return renderSpacer(node, width);
    case "image":
      return renderImage(node, width);
    case "box":
      return renderBox(node, width);
  }
}

function renderText(node: SpatialTextNode, width: number): string[] {
  const codes: number[] = toneCodes(node.tone);
  const heading = node.style === "heading";
  const sub = node.style === "subheading";
  if (node.bold || heading || sub) codes.push(1);
  if (node.dim || node.style === "caption" || node.style === "label")
    codes.push(2);
  if (heading) codes.push(4); // underline a heading

  const lines =
    node.wrap === false
      ? [truncateToWidth(node.value, width, "…", false)]
      : wrapTextWithAnsi(node.value, width);

  const align = node.align ?? "start";
  return lines.map((line) => alignH(sgr(line, codes), width, align));
}

function renderButton(node: SpatialButtonNode, width: number): string[] {
  const variant = node.variant ?? "solid";
  const focused = node.agent?.id != null && node.agent.id === focusedAgentId;
  const codes = toneCodes(node.tone ?? "primary");
  codes.push(1); // bold
  if (variant === "solid" || focused) codes.push(7); // inverse fill
  if (focused) codes.push(4); // underline the focused control
  if (node.disabled) codes.push(2);
  // Focus is shown with inverse + underline only — no width change.
  const label = `[ ${node.label} ]`;
  return [
    alignH(
      sgr(fitWidth(label, Math.min(visibleWidth(label), width)), codes),
      width,
      "start",
    ),
  ];
}

function renderField(node: SpatialFieldNode, width: number): string[] {
  const out: string[] = [];
  if (node.label) out.push(fitWidth(sgr(node.label, [2]), width));
  const shown = node.value ?? node.placeholder ?? "";
  const isPlaceholder = !node.value && !!node.placeholder;
  const masked =
    node.kind === "password" && node.value
      ? "•".repeat(node.value.length)
      : shown;
  const indicator = node.kind === "select" ? "▾ " : "› ";
  const body = `${indicator}${masked}`;
  const styled = isPlaceholder ? sgr(body, [2]) : body;
  out.push(fitWidth(styled, width));
  return out;
}

function renderDivider(node: SpatialDividerNode, width: number): string[] {
  if (node.orientation === "vertical") {
    return [sgr("│", [90])];
  }
  if (node.label) {
    const caption = ` ${node.label} `;
    const remaining = Math.max(0, width - visibleWidth(caption));
    const left = Math.floor(remaining / 2);
    const right = remaining - left;
    return [sgr("─".repeat(left) + caption + "─".repeat(right), [90])];
  }
  return [sgr("─".repeat(width), [90])];
}

function renderSpacer(_node: SpatialSpacerNode, width: number): string[] {
  // A spacer is one blank line here; a column expands a sized spacer vertically
  // (see renderColumn) and a row sizes it horizontally (see measureWidth).
  return [blank(width)];
}

function renderImage(node: SpatialImageNode, width: number): string[] {
  return [fitWidth(sgr(`▢ ${node.alt || "image"}`, [90]), width)];
}

// --- Box rendering ----------------------------------------------------------

interface ChildPlacement {
  node: SpatialNode;
  width: number;
}

const BORDER_GLYPHS: Record<
  Exclude<SpatialBorder, "none">,
  {
    tl: string;
    tr: string;
    bl: string;
    br: string;
    h: string;
    v: string;
  }
> = {
  single: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  round: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  double: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
};

function renderBox(node: SpatialBoxNode, width: number): string[] {
  const ins = insets(node);
  const innerW = Math.max(0, width - ins.l - ins.r);
  const innerLines =
    node.direction === "row"
      ? renderRow(node, innerW)
      : renderColumn(node, innerW);

  // Vertical padding (inside border).
  const p = resolvePadding(node.padding);
  const padded = [
    ...Array.from({ length: p.top }, () => blank(innerW)),
    ...innerLines,
    ...Array.from({ length: p.bottom }, () => blank(innerW)),
  ];

  // Horizontal padding + optional border.
  const bw = borderSize(node.border);
  const leftPad = blank(p.left);
  const rightPad = blank(p.right);
  const body = padded.map((line) =>
    fitWidth(leftPad + fitWidth(line, innerW) + rightPad, width - bw * 2),
  );

  if (bw === 0) {
    const out = body.map((line) => fitWidth(line, width));
    return applyFixedHeight(node, out, width);
  }

  const glyphs =
    BORDER_GLYPHS[(node.border as Exclude<SpatialBorder, "none">) ?? "single"];
  const borderCodes = toneCodes(node.tone);
  const top = renderTopBorder(node, glyphs, width, borderCodes);
  const bottom = sgr(
    glyphs.bl + glyphs.h.repeat(Math.max(0, width - 2)) + glyphs.br,
    borderCodes,
  );
  const v = sgr(glyphs.v, borderCodes);
  const wrapped = body.map((line) => v + fitWidth(line, width - 2) + v);
  const out = [top, ...wrapped, bottom];
  return applyFixedHeight(node, out, width);
}

function renderTopBorder(
  node: SpatialBoxNode,
  glyphs: { tl: string; tr: string; h: string },
  width: number,
  codes: number[],
): string {
  const inner = Math.max(0, width - 2);
  if (node.title && inner > 4) {
    const caption = ` ${node.title} `;
    const cw = Math.min(visibleWidth(caption), inner - 1);
    const fill = inner - cw;
    const line =
      glyphs.tl +
      glyphs.h +
      truncateToWidth(caption, cw, "", false) +
      glyphs.h.repeat(Math.max(0, fill - 1)) +
      glyphs.tr;
    return sgr(line, codes);
  }
  return sgr(glyphs.tl + glyphs.h.repeat(inner) + glyphs.tr, codes);
}

function applyFixedHeight(
  node: SpatialNode,
  lines: string[],
  width: number,
): string[] {
  const h = resolveLength(node.height, Number.MAX_SAFE_INTEGER);
  if (h === null) return lines;
  if (lines.length === h) return lines;
  if (lines.length > h) return lines.slice(0, h);
  return [
    ...lines,
    ...Array.from({ length: h - lines.length }, () => blank(width)),
  ];
}

/** Resolve each child's target width for a row, distributing grow + fitting. */
function placeRowChildren(
  children: SpatialNode[],
  innerW: number,
  gap: number,
): ChildPlacement[] {
  const totalGap = gap * Math.max(0, children.length - 1);
  const avail = Math.max(0, innerW - totalGap);

  const natural = children.map((c) => measureWidth(c, avail));
  const growFactors = children.map((c) =>
    c.type === "spacer" ? (c.grow ?? 1) : (c.grow ?? 0),
  );
  const naturalSum = natural.reduce((a, b) => a + b, 0);
  const growSum = growFactors.reduce((a, b) => a + b, 0);
  const free = avail - naturalSum;

  const widths = [...natural];
  if (free > 0 && growSum > 0) {
    let distributed = 0;
    for (let i = 0; i < children.length; i++) {
      if (growFactors[i] > 0) {
        const extra = Math.floor((free * growFactors[i]) / growSum);
        widths[i] += extra;
        distributed += extra;
      }
    }
    // Hand any rounding remainder to the last grow child.
    const remainder = free - distributed;
    for (let i = children.length - 1; i >= 0 && remainder > 0; i--) {
      if (growFactors[i] > 0) {
        widths[i] += remainder;
        break;
      }
    }
  } else if (free < 0) {
    // Over-budget: shrink shrinkable children proportionally to fit.
    const shrinkable = children.map((c, i) =>
      c.shrink === 0 ? 0 : natural[i],
    );
    const shrinkSum = shrinkable.reduce((a, b) => a + b, 0);
    let deficit = -free;
    if (shrinkSum > 0) {
      for (let i = 0; i < children.length && deficit > 0; i++) {
        if (shrinkable[i] === 0) continue;
        const take = Math.min(
          widths[i],
          Math.ceil((deficit * shrinkable[i]) / shrinkSum),
        );
        widths[i] -= take;
        deficit -= take;
      }
    }
  }

  return children.map((node, i) => ({ node, width: Math.max(0, widths[i]) }));
}

function renderRow(node: SpatialBoxNode, innerW: number): string[] {
  const active = node.children;
  if (active.length === 0) return [];

  // Wrap into multiple rows if requested and content overflows.
  const rowsOfChildren: SpatialNode[][] = [];
  if (node.wrap) {
    let line: SpatialNode[] = [];
    let used = 0;
    for (const c of active) {
      const w = measureWidth(c, innerW);
      const withGap = used === 0 ? w : used + node.gap + w;
      if (used > 0 && withGap > innerW) {
        rowsOfChildren.push(line);
        line = [c];
        used = w;
      } else {
        line.push(c);
        used = withGap;
      }
    }
    if (line.length > 0) rowsOfChildren.push(line);
  } else {
    rowsOfChildren.push(active);
  }

  const out: string[] = [];
  rowsOfChildren.forEach((rowChildren, rowIdx) => {
    if (rowIdx > 0) {
      for (let g = 0; g < node.gap; g++) out.push(blank(innerW));
    }
    out.push(...composeRow(node, rowChildren, innerW));
  });
  return out;
}

function composeRow(
  node: SpatialBoxNode,
  rowChildren: SpatialNode[],
  innerW: number,
): string[] {
  const placements = placeRowChildren(rowChildren, innerW, node.gap);
  const blocks = placements.map((p) => render(p.node, p.width));
  const rowHeight = Math.max(1, ...blocks.map((b) => b.length));
  const crossAlign = node.align ?? "start";

  const paddedBlocks = blocks.map((block, i) => {
    const w = placements[i].width;
    return padBlockV(
      block.map((l) => fitWidth(l, w)),
      w,
      rowHeight,
      crossAlign === "stretch" ? "stretch" : crossAlign,
    );
  });

  // Leading offset for justify when there is unused horizontal space.
  const contentW =
    placements.reduce((a, p) => a + p.width, 0) +
    node.gap * Math.max(0, placements.length - 1);
  const slack = Math.max(0, innerW - contentW);
  const justify = node.justify ?? "start";
  const lead =
    justify === "center"
      ? Math.floor(slack / 2)
      : justify === "end"
        ? slack
        : 0;
  const between =
    justify === "between" && placements.length > 1
      ? Math.floor(slack / (placements.length - 1))
      : 0;

  const lines: string[] = [];
  for (let y = 0; y < rowHeight; y++) {
    let line = blank(lead);
    paddedBlocks.forEach((block, i) => {
      if (i > 0) line += blank(node.gap + between);
      line += block[y];
    });
    lines.push(fitWidth(line, innerW));
  }
  return lines;
}

function renderColumn(node: SpatialBoxNode, innerW: number): string[] {
  const out: string[] = [];
  const justify = node.justify ?? "start";
  const align = node.align ?? "stretch";

  const blocks: string[][] = [];
  for (const child of node.children) {
    // A sized spacer in a column is vertical whitespace of `size` rows.
    if (child.type === "spacer" && (child.size ?? 0) > 0) {
      blocks.push(
        Array.from({ length: child.size as number }, () => blank(innerW)),
      );
      continue;
    }
    const target =
      align === "stretch" &&
      child.grow === undefined &&
      child.width === undefined
        ? innerW
        : Math.min(measureWidth(child, innerW), innerW);
    const childW =
      child.width !== undefined
        ? (resolveLength(child.width, innerW) ?? target)
        : target;
    const block = render(child, childW).map((l) => fitWidth(l, childW));
    // Align the child block horizontally within the column's inner width.
    const placed = block.map((l) =>
      alignH(
        l,
        innerW,
        align === "center" ? "center" : align === "end" ? "end" : "start",
      ),
    );
    blocks.push(placed);
  }

  blocks.forEach((block, i) => {
    if (i > 0) {
      for (let g = 0; g < node.gap; g++) out.push(blank(innerW));
    }
    out.push(...block);
  });

  // Vertical justify only applies when a fixed height leaves slack.
  const fixedH = resolveLength(node.height, Number.MAX_SAFE_INTEGER);
  if (fixedH !== null && out.length < fixedH) {
    const ins = insets(node);
    const target = fixedH - ins.t - ins.b;
    const free = Math.max(0, target - out.length);
    if (free > 0 && justify !== "start") {
      const top =
        justify === "center"
          ? Math.floor(free / 2)
          : justify === "end"
            ? free
            : 0;
      const bottom = free - top;
      return [
        ...Array.from({ length: top }, () => blank(innerW)),
        ...out,
        ...Array.from({ length: bottom }, () => blank(innerW)),
      ];
    }
  }
  return out;
}
