/**
 * Eval gates — release-blocking thresholds for voice-pipeline changes.
 *
 * Per AGENTS.md evidence-or-it-didn't-happen rule, every optimization PR
 * for the voice loop must produce a fresh bench JSON and compare against
 * the recorded baseline. This module implements the comparison and
 * emits a markdown summary suitable for the PR description.
 *
 * Thresholds (warn / fail), regression percent versus baseline:
 *   - TTFA p50:        +20% warn,  +50% fail
 *   - TTFA p95:        +30% warn,  +50% fail
 *   - Barge-in p95:    250 ms hard ceiling (absolute)
 *   - False-barge-in:  0.05/turn ceiling (absolute)
 *   - Rollback waste:  0.30 ceiling (absolute)
 */

import type {
  BenchAggregates,
  BenchMetrics,
  BenchRegression,
  BenchRun,
  GateReport,
} from "./types.ts";
import { percentile } from "./metrics.ts";

export interface RegressionGates {
  ttfaP50WarnPct: number;
  ttfaP50FailPct: number;
  ttfaP95WarnPct: number;
  ttfaP95FailPct: number;
  bargeInP95CeilingMs: number;
  falseBargeInRateCeiling: number;
  rollbackWasteCeiling: number;
}

export const DEFAULT_GATES: RegressionGates = {
  ttfaP50WarnPct: 20,
  ttfaP50FailPct: 50,
  ttfaP95WarnPct: 30,
  ttfaP95FailPct: 50,
  bargeInP95CeilingMs: 250,
  falseBargeInRateCeiling: 0.05,
  rollbackWasteCeiling: 0.3,
};

export function aggregate(metrics: BenchMetrics[]): BenchAggregates {
  if (metrics.length === 0) {
    return {
      ttfaP50: 0,
      ttfaP95: 0,
      e2eP50: 0,
      e2eP95: 0,
      falseBargeInRate: 0,
      rollbackWastePct: 0,
    };
  }
  const ttfa = metrics.map((m) => m.ttfaMs);
  const e2e = metrics.map((m) => m.e2eLatencyMs);
  const falseTotal = metrics.reduce((s, m) => s + m.falseBargeInCount, 0);
  const draftTotal = metrics.reduce((s, m) => s + m.draftTokensTotal, 0);
  const draftWasted = metrics.reduce((s, m) => s + m.draftTokensWasted, 0);
  return {
    ttfaP50: percentile(ttfa, 50),
    ttfaP95: percentile(ttfa, 95),
    e2eP50: percentile(e2e, 50),
    e2eP95: percentile(e2e, 95),
    falseBargeInRate: falseTotal / metrics.length,
    rollbackWastePct: draftTotal === 0 ? 0 : draftWasted / draftTotal,
  };
}

interface AbsoluteCheckArgs {
  metric: string;
  current: number;
  ceiling: number;
}

function absoluteCheck(args: AbsoluteCheckArgs): BenchRegression {
  const { metric, current, ceiling } = args;
  const severity: BenchRegression["severity"] = current > ceiling ? "fail" : "ok";
  // pctChange against the ceiling is informational: how much over/under.
  const pctChange = ceiling === 0 ? 0 : ((current - ceiling) / ceiling) * 100;
  return {
    metric,
    baseline: ceiling,
    current,
    pctChange: round1(pctChange),
    severity,
    threshold: { warn: ceiling, fail: ceiling },
  };
}

interface RegressionCheckArgs {
  metric: string;
  baseline: number;
  current: number;
  warnPct: number;
  failPct: number;
}

function regressionCheck(args: RegressionCheckArgs): BenchRegression {
  const { metric, baseline, current, warnPct, failPct } = args;
  if (baseline === 0) {
    // Nothing to compare against — record but mark ok.
    return {
      metric,
      baseline,
      current,
      pctChange: 0,
      severity: "ok",
      threshold: { warn: warnPct, fail: failPct },
    };
  }
  const pctChange = ((current - baseline) / baseline) * 100;
  let severity: BenchRegression["severity"] = "ok";
  if (pctChange >= failPct) severity = "fail";
  else if (pctChange >= warnPct) severity = "warn";
  return {
    metric,
    baseline,
    current,
    pctChange: round1(pctChange),
    severity,
    threshold: { warn: warnPct, fail: failPct },
  };
}

export interface EvaluateGatesOpts {
  current: BenchRun;
  baseline?: BenchRun;
  gates?: RegressionGates;
}

export function evaluateGates(opts: EvaluateGatesOpts): GateReport {
  const gates = opts.gates ?? DEFAULT_GATES;
  const cur = opts.current.aggregates;
  const base = opts.baseline?.aggregates;
  const rows: BenchRegression[] = [];

  if (base) {
    rows.push(
      regressionCheck({
        metric: "TTFA p50 (ms)",
        baseline: base.ttfaP50,
        current: cur.ttfaP50,
        warnPct: gates.ttfaP50WarnPct,
        failPct: gates.ttfaP50FailPct,
      }),
      regressionCheck({
        metric: "TTFA p95 (ms)",
        baseline: base.ttfaP95,
        current: cur.ttfaP95,
        warnPct: gates.ttfaP95WarnPct,
        failPct: gates.ttfaP95FailPct,
      }),
    );
  }

  // Absolute ceilings — always evaluated.
  const bargeIns = opts.current.fixtures
    .map((m) => m.bargeInResponseMs)
    .filter((v): v is number => typeof v === "number");
  if (bargeIns.length > 0) {
    rows.push(
      absoluteCheck({
        metric: "Barge-in response p95 (ms)",
        current: percentile(bargeIns, 95),
        ceiling: gates.bargeInP95CeilingMs,
      }),
    );
  }
  rows.push(
    absoluteCheck({
      metric: "False-barge-in rate (per turn)",
      current: cur.falseBargeInRate,
      ceiling: gates.falseBargeInRateCeiling,
    }),
    absoluteCheck({
      metric: "Rollback waste (fraction)",
      current: cur.rollbackWastePct,
      ceiling: gates.rollbackWasteCeiling,
    }),
  );

  const passed = rows.every((r) => r.severity !== "fail");
  return { passed, rows, markdown: renderMarkdown(opts.current, rows) };
}

function renderMarkdown(run: BenchRun, rows: BenchRegression[]): string {
  const header = `## Voice-bench gate report\n\n- Bundle: \`${run.bundleId}\`\n- Backend: \`${run.backend}\`\n- Device: \`${run.deviceLabel}\`\n- Run: \`${run.runId}\` @ ${run.timestamp}\n- Git: \`${run.gitSha}\`\n\n`;
  const tableHeader = "| Metric | Baseline | Current | Δ% | Severity |\n|---|---:|---:|---:|:---:|\n";
  const tableBody = rows
    .map(
      (r) =>
        `| ${r.metric} | ${r.baseline.toFixed(2)} | ${r.current.toFixed(2)} | ${r.pctChange > 0 ? "+" : ""}${r.pctChange.toFixed(1)}% | ${badge(r.severity)} |`,
    )
    .join("\n");
  const passed = rows.every((r) => r.severity !== "fail");
  const footer = `\n\nGate: **${passed ? "PASS" : "FAIL"}**\n`;
  return header + tableHeader + tableBody + footer;
}

function badge(severity: BenchRegression["severity"]): string {
  switch (severity) {
    case "ok":
      return "OK";
    case "warn":
      return "WARN";
    case "fail":
      return "FAIL";
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
