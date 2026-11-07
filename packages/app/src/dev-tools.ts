import {
  toWellFormedUnicode,
  truncateWellFormed,
} from "@elizaos/core/protocol";

export type DevSettingsRow = {
  setting: string;
  effective: string;
  source: string;
  change: string;
};

export type DevSettingsTableOptions = {
  /** Maximum line length (default 80). */
  narrowWidth?: number;
  /** Draw a Unicode frame (default true). */
  narrowFrame?: boolean;
};

function requireWidth(width: number, minimum = 1): void {
  if (!Number.isSafeInteger(width) || width < minimum) {
    throw new RangeError(`Table width must be a safe integer >= ${minimum}`);
  }
}

export function truncateCell(value: string, maxWidth: number): string {
  requireWidth(maxWidth, 0);
  const wellFormed = toWellFormedUnicode(value);
  if (wellFormed.length <= maxWidth) return wellFormed;
  if (maxWidth < 2) return truncateWellFormed(wellFormed, maxWidth);
  return `${truncateWellFormed(wellFormed, maxWidth - 1)}…`;
}

/** Word-wrap to at most `width` columns; breaks on spaces, then hard-breaks long tokens. */
export function wrapToWidth(text: string, width: number): string[] {
  requireWidth(width);
  const normalized = toWellFormedUnicode(text).replace(/\s+/g, " ").trim();
  if (!normalized) return [""];
  const lines: string[] = [];
  let remaining = normalized;
  while (remaining.length > 0) {
    if (remaining.length <= width) {
      lines.push(remaining);
      break;
    }
    let breakAt = remaining.lastIndexOf(" ", width);
    if (breakAt <= 0) breakAt = width;
    // Never split a surrogate pair at a hard wrap boundary.
    if (
      breakAt < remaining.length &&
      /[\uDC00-\uDFFF]/.test(remaining[breakAt])
    ) {
      breakAt = breakAt > 1 ? breakAt - 1 : 2;
    }
    const chunk = remaining.slice(0, breakAt).trimEnd();
    lines.push(chunk.length > 0 ? chunk : remaining.slice(0, width));
    remaining = remaining.slice(breakAt).trimStart();
  }
  return lines;
}

function emitLabeledLines(
  label: string,
  value: string,
  maxWidth: number,
): string[] {
  const prefix = `  ${label}: `;
  const budget = maxWidth - prefix.length;
  if (budget < 12) {
    return [
      `  ${label}:`,
      ...wrapToWidth(value, Math.max(8, maxWidth - 2)).map((l) => `    ${l}`),
    ];
  }
  const wrapped = wrapToWidth(value, budget);
  const out: string[] = [`${prefix}${wrapped[0] ?? ""}`];
  const pad = " ".repeat(prefix.length);
  for (let j = 1; j < wrapped.length; j++) out.push(`${pad}${wrapped[j]}`);
  return out;
}

export function boxTopRule(title: string, outer: number): string {
  requireWidth(outer, 0);
  const inner = outer - 2;
  if (inner < 4)
    return truncateWellFormed(toWellFormedUnicode(title), Math.max(0, outer));
  const maxTitle = Math.max(1, inner - 4);
  let t = toWellFormedUnicode(title);
  if (t.length > maxTitle)
    t = `${truncateWellFormed(t, Math.max(1, maxTitle - 1))}…`;
  const padDash = inner - 2 - t.length;
  const left = Math.max(0, Math.floor(padDash / 2));
  const right = Math.max(0, padDash - left);
  return `╭${"─".repeat(left)} ${t} ${"─".repeat(right)}╮`;
}

function boxMidRule(outer: number): string {
  const inner = outer - 2;
  return `├${"─".repeat(inner)}┤`;
}

function boxBottomRule(outer: number): string {
  const inner = outer - 2;
  return `╰${"─".repeat(inner)}╯`;
}

function boxEmptyRow(outer: number): string {
  const inner = outer - 2;
  return `│${" ".repeat(inner)}│`;
}

export function boxRow(line: string, outer: number): string {
  requireWidth(outer, 6);
  const inner = outer - 2;
  const maxMid = Math.max(0, inner - 4);
  const wellFormed = toWellFormedUnicode(line);
  const vis =
    wellFormed.length > maxMid ? truncateCell(wellFormed, maxMid) : wellFormed;
  const pad = maxMid - vis.length;
  return `│ ${vis}${" ".repeat(pad)} │`;
}

function formatDevSettingsTableNarrowUnframed(
  title: string,
  rows: DevSettingsRow[],
  maxWidth: number,
): string {
  const sep = "—".repeat(Math.min(maxWidth, 40));
  const lines: string[] = [`=== ${title} ===`, ""];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    lines.push(...wrapToWidth(r.setting, maxWidth));
    lines.push(...emitLabeledLines("Effective", r.effective, maxWidth));
    lines.push(...emitLabeledLines("Source", r.source, maxWidth));
    lines.push(...emitLabeledLines("Change", r.change, maxWidth));
    if (i < rows.length - 1) lines.push("", sep, "");
    else lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Multiline block per row; each output line ≤ outerWidth (default 80).
 * When `frame` is true, draws a light Unicode border; inner text wraps to fit.
 */
export function formatDevSettingsTableNarrow(
  title: string,
  rows: DevSettingsRow[],
  outerWidth = 80,
  frame = true,
): string {
  requireWidth(outerWidth);
  if (!frame) {
    return formatDevSettingsTableNarrowUnframed(title, rows, outerWidth);
  }
  const outer = Math.max(24, outerWidth);
  const inner = outer - 2;
  const contentW = Math.max(8, inner - 4);
  const lines: string[] = [];
  lines.push(boxTopRule(title, outer));
  lines.push(boxEmptyRow(outer));
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const block: string[] = [];
    block.push(...wrapToWidth(r.setting, contentW));
    block.push(...emitLabeledLines("Effective", r.effective, contentW));
    block.push(...emitLabeledLines("Source", r.source, contentW));
    block.push(...emitLabeledLines("Change", r.change, contentW));
    for (const ln of block) lines.push(boxRow(ln, outer));
    if (i < rows.length - 1) {
      lines.push(boxEmptyRow(outer));
      lines.push(boxMidRule(outer));
      lines.push(boxEmptyRow(outer));
    }
  }
  lines.push(boxEmptyRow(outer));
  lines.push(boxBottomRule(outer));
  return `${lines.join("\n")}\n`;
}

/** Format a multiline startup settings banner. */
export function formatDevSettingsTable(
  title: string,
  rows: DevSettingsRow[],
  options?: DevSettingsTableOptions,
): string {
  return formatDevSettingsTableNarrow(
    title,
    rows,
    options?.narrowWidth ?? 80,
    options?.narrowFrame !== false,
  );
}

const RESET = "\x1b[0m";
const BOLD_CYAN = "\x1b[1;36m";
const DIM_CYAN = "\x1b[2;36m";
const BOLD_MAGENTA = "\x1b[1;35m";

function shouldSkipBannerColor(): boolean {
  if (typeof process === "undefined" || !process.env) return true;
  if ("NO_COLOR" in process.env) return true;
  const fc = process.env.FORCE_COLOR;
  if (fc === "0" || fc === "false") return true;
  if (fc === "1" || fc === "true") return false;
  if (typeof process.stdout.isTTY === "boolean" && !process.stdout.isTTY)
    return true;
  return false;
}

function colorizeDevSettingsBannerLine(line: string): string {
  if (line.length === 0) return line;
  const c0 = line.codePointAt(0);
  if (c0 === 0x256d /* ╭ */ || c0 === 0x2570 /* ╰ */)
    return `${BOLD_CYAN}${line}${RESET}`;
  if (c0 === 0x251c /* ├ */) return `${DIM_CYAN}${line}${RESET}`;
  if (c0 === 0x2502 /* │ */) return `${DIM_CYAN}${line}${RESET}`;
  return line;
}

/** Add cyan emphasis to Unicode box lines; returns input unchanged when color is disabled. */
export function colorizeDevSettingsBanner(text: string): string {
  if (shouldSkipBannerColor()) return text;
  return text.split("\n").map(colorizeDevSettingsBannerLine).join("\n");
}

/**
 * Colorize a block that may start with a figlet heading, then a framed table (and optional
 * plain footer after the box). Figlet lines are magenta; box lines stay cyan.
 */
export function colorizeDevSettingsStartupBanner(text: string): string {
  if (shouldSkipBannerColor()) return text;
  const idx = text.indexOf("╭");
  if (idx === -1) return colorizeDevSettingsBanner(text);
  const head = text.slice(0, idx).replace(/\n+$/u, "");
  const tail = text.slice(idx);
  const coloredHead = head ? `${BOLD_MAGENTA}${head}${RESET}\n` : "";
  return coloredHead + colorizeDevSettingsBanner(tail);
}

function renderFallbackHeading(text: string): string {
  const rule = "_".repeat(text.length + 2);
  return [` ${rule} `, `| ${text} |`, `|${rule}|`].join("\n");
}

/** Subsystem printed as giant ASCII above each dev settings table. */
export type DevSubsystemBannerKind =
  | "orchestrator"
  | "vite"
  | "api"
  | "electrobun";

/** Renders a plain boxed heading (short marker) for the given subsystem. */
export function renderDevSubsystemFigletHeading(
  kind: DevSubsystemBannerKind,
): string {
  return renderFallbackHeading(kind.toUpperCase());
}

/** Heading block, blank line, then the settings table (and any trailing footer). */
export function prependDevSubsystemFigletHeading(
  kind: DevSubsystemBannerKind,
  tableAndFooter: string,
): string {
  const head = renderDevSubsystemFigletHeading(kind);
  return `${head}\n\n${tableAndFooter}`;
}
