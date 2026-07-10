/**
 * Shared config, timing summary, and report rendering for staging voice ops.
 *
 * The staging tools intentionally use a separate artifact schema from the
 * direct-provider RTT harness because they exercise cloud routes and redacted
 * operational timings rather than provider-specific traces.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { summarize } from "./metrics.ts";
import type { PercentileSummary } from "./types.ts";

export interface StagingReport<TMetric extends string, TRun> {
  schemaVersion: 1;
  generatedAt: string;
  tool: string;
  target: {
    baseUrl: string;
    paths: Record<string, string>;
  };
  summaries: Record<TMetric, PercentileSummary>;
  runs: TRun[];
}

export function readJsonConfig<T>(path: string): T {
  if (!existsSync(path)) {
    throw new Error(`config file not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

export function parsePositiveInt(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`expected a positive integer, received ${value}`);
  }
  return parsed;
}

export function metricSummaries<TMetric extends string, TRun>(
  runs: readonly TRun[],
  metricNames: readonly TMetric[],
  readMetric: (run: TRun, metric: TMetric) => number | null,
): Record<TMetric, PercentileSummary> {
  const output = {} as Record<TMetric, PercentileSummary>;
  for (const metric of metricNames) {
    output[metric] = summarize(runs.map((run) => readMetric(run, metric)));
  }
  return output;
}

export function renderStagingJson<TMetric extends string, TRun>(
  report: StagingReport<TMetric, TRun>,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderStagingMarkdown<TMetric extends string, TRun>(
  report: StagingReport<TMetric, TRun>,
  runTable: string[],
): string {
  const lines: string[] = [];
  lines.push(`# ${report.tool} Report`);
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Target: ${report.target.baseUrl}`);
  for (const [name, path] of Object.entries(report.target.paths)) {
    lines.push(`- ${name}: ${path}`);
  }
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | n | p50 | p90 | p95 | mean | min | max |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const [metric, summary] of Object.entries(report.summaries) as Array<
    [TMetric, PercentileSummary]
  >) {
    lines.push(
      `| ${metric} | ${summary.count} | ${fmt(summary.p50)} | ${fmt(summary.p90)} | ${fmt(summary.p95)} | ${fmt(summary.mean)} | ${fmt(summary.min)} | ${fmt(summary.max)} |`,
    );
  }
  lines.push("");
  lines.push("## Runs");
  lines.push("");
  lines.push(...runTable);
  return `${lines.join("\n")}\n`;
}

export function writeReportFiles(args: {
  outDir: string;
  json: string;
  markdown: string;
  jsonName?: string;
  markdownName?: string;
}): void {
  const outDir = resolve(args.outDir);
  mkdirSync(outDir, { recursive: true });
  const jsonPath = resolve(outDir, args.jsonName ?? "report.json");
  const markdownPath = resolve(outDir, args.markdownName ?? "report.md");
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, args.json, "utf8");
  writeFileSync(markdownPath, args.markdown, "utf8");
  process.stdout.write(`Wrote ${jsonPath}\n`);
  process.stdout.write(`Wrote ${markdownPath}\n`);
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function nowMs(): number {
  return performance.now();
}

export function duration(startMs: number, endMs: number | null): number | null {
  return endMs === null ? null : endMs - startMs;
}

export function redactIdentifier(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  if (value.length <= 8) return "<redacted>";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function fmt(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return `${Math.round(value)}ms`;
}
