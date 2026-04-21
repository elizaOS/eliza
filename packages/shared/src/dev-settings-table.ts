/**
 * Plain-text tables for dev startup banners (orchestrator, Vite, API, Electrobun).
 * Narrow layout uses Unicode box drawing (no ANSI here). Use `dev-settings-banner-style`
 * when printing to a TTY for cyan emphasis.
 *
 * Why: Multi-process desktop dev prints four overlapping env snapshots; a framed
 * table makes effective ports and sources scannable in the terminal (developer
 * observability, not end-user product UI).
 */

export type DevSettingsRow = {
  setting: string;
  effective: string;
  source: string;
  change: string;
};

const DEFAULT_CAPS = {
  setting: 44,
  effective: 16,
  source: 52,
  change: 64,
} as const;

export type DevSettingsTableOptions = {
  caps?: Partial<typeof DEFAULT_CAPS>;
  /** Multiline ~80 cols by default; set `wide` for legacy single-line table. */
  layout?: "wide" | "narrow";
  /** Max line length for `layout: "narrow"` (default 80). */
  narrowWidth?: number;
  /**
   * When `layout` is `narrow`, draw a Unicode frame (default true).
   * Set false for plain `=== title ===` blocks (e.g. tests or log capture).
   */
  narrowFrame?: boolean;
};

function truncateCell(value: string, maxWidth: number): string {
  if (value.length <= maxWidth) return value;
  if (maxWidth < 2) return value.slice(0, maxWidth);
  return `${value.slice(0, maxWidth - 1)}…`;
}

/** Word-wrap to at most `width` columns; breaks on spaces, then hard-breaks long tokens. */
export function wrapToWidth(text: string, width: number): string[] {
  if (width < 1) return [text];
  const normalized = text.replace(/\s+/g, " ").trim();
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
    const chunk = remaining.slice(0, breakAt).trimEnd();
    lines.push(chunk.length > 0 ? chunk : remaining.slice(0, width));
    remaining = remaining
      .slice(breakAt === width ? width : breakAt)
      .trimStart();
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

function boxTopRule(title: string, outer: number): string {
  const inner = outer - 2;
  if (inner < 4) return title.slice(0, Math.max(0, outer));
  const maxTitle = Math.max(1, inner - 4);
  let t = title;
  if (t.length > maxTitle) t = `${t.slice(0, Math.max(1, maxTitle - 1))}…`;
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

function boxRow(line: string, outer: number): string {
  const inner = outer - 2;
  const maxMid = Math.max(0, inner - 4);
  const vis =
    line.length > maxMid ? `${line.slice(0, Math.max(0, maxMid - 1))}…` : line;
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

/**
 * Format a titled dev settings banner. Default is multiline (~80 cols); pass
 * `layout: "wide"` for the legacy four-column table with Setting/Effective/Source/Change header.
 */
export function formatDevSettingsTable(
  title: string,
  rows: DevSettingsRow[],
  options?: DevSettingsTableOptions,
): string {
  const layout = options?.layout ?? "narrow";
  if (layout === "narrow") {
    return formatDevSettingsTableNarrow(
      title,
      rows,
      options?.narrowWidth ?? 80,
      options?.narrowFrame !== false,
    );
  }
  const caps = { ...DEFAULT_CAPS, ...options?.caps };
  const header: DevSettingsRow = {
    setting: "Setting",
    effective: "Effective",
    source: "Source",
    change: "Change",
  };
  let w0 = header.setting.length;
  let w1 = header.effective.length;
  let w2 = header.source.length;
  let w3 = header.change.length;
  for (const r of rows) {
    w0 = Math.max(w0, r.setting.length);
    w1 = Math.max(w1, r.effective.length);
    w2 = Math.max(w2, r.source.length);
    w3 = Math.max(w3, r.change.length);
  }
  w0 = Math.min(caps.setting, w0);
  w1 = Math.min(caps.effective, w1);
  w2 = Math.min(caps.source, w2);
  w3 = Math.min(caps.change, w3);

  const fmt = (r: DevSettingsRow) =>
    [
      truncateCell(r.setting, w0).padEnd(w0),
      truncateCell(r.effective, w1).padEnd(w1),
      truncateCell(r.source, w2).padEnd(w2),
      truncateCell(r.change, w3),
    ].join("  ");

  const lines = [
    `=== ${title} ===`,
    fmt(header),
    "-".repeat(w0 + w1 + w2 + w3 + 6),
    ...rows.map(fmt),
  ];
  return `${lines.join("\n")}\n`;
}
