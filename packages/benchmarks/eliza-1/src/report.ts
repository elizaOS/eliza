/**
 * Bench report renderer.
 *
 * Prints a console table grouped by (task, mode) with the three quality rates
 * + p50/p95 latency + mean tok/s. Also serialises the full report to JSON for
 * downstream comparison.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BenchReport, ModeSummary } from "./types.ts";

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function ms(value: number | null): string {
  if (value === null) return "n/a";
  if (value < 1000) return `${value.toFixed(1)}ms`;
  return `${(value / 1000).toFixed(2)}s`;
}

function num(value: number): string {
  return value.toFixed(1);
}

/**
 * Build the table rows. Pulled out so the test can assert on the rows without
 * having to scrape stdout.
 */
export function buildTableRows(summaries: ModeSummary[]): string[][] {
  const header = [
    "task",
    "mode",
    "n",
    "parse%",
    "schema%",
    "label%",
    "ftl_p50",
    "ftl_p95",
    "lat_p50",
    "lat_p95",
    "tok/s",
  ];
  const rows = summaries.map((s) => [
    s.taskId,
    s.modeId,
    String(s.cases),
    pct(s.parse_success_rate),
    pct(s.schema_valid_rate),
    pct(s.label_match_rate),
    ms(s.first_token_latency_p50_ms),
    ms(s.first_token_latency_p95_ms),
    ms(s.total_latency_p50_ms),
    ms(s.total_latency_p95_ms),
    num(s.mean_tokens_per_second),
  ]);
  return [header, ...rows];
}

/** Render the table as a left-aligned, fixed-width text block. */
export function renderTable(rows: string[][]): string {
  if (rows.length === 0) return "";
  const widths = rows[0].map((_, c) =>
    rows.reduce((max, r) => Math.max(max, r[c]?.length ?? 0), 0),
  );
  const sep = `+${widths.map((w) => "-".repeat(w + 2)).join("+")}+`;
  const lines: string[] = [sep];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const padded = row.map((cell, c) => ` ${cell.padEnd(widths[c])} `);
    lines.push(`|${padded.join("|")}|`);
    if (i === 0) lines.push(sep);
  }
  lines.push(sep);
  return lines.join("\n");
}

/** Render a full report to a printable string. */
export function renderReport(report: BenchReport): string {
  const lines: string[] = [];
  lines.push("eliza-1 bench report");
  lines.push(`generated: ${report.generatedAt}`);
  lines.push(`tasks:     ${report.tasks.join(", ")}`);
  lines.push(`modes:     ${report.modes.join(", ")}`);
  if (report.skipped.length > 0) {
    lines.push("skipped:");
    for (const s of report.skipped) {
      lines.push(`  - ${s.modeId}: ${s.reason}`);
    }
  }
  lines.push("");
  lines.push(renderTable(buildTableRows(report.summaries)));
  lines.push("");
  return lines.join("\n");
}

/** Write the JSON report to disk, creating parent dirs as needed. */
export function writeReportJson(report: BenchReport, outPath: string): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
