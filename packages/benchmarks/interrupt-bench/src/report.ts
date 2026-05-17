/**
 * Render the benchmark report in markdown + JSON.
 *
 * Markdown is for humans; JSON is for downstream tooling. Both contain the
 * same aggregate score, per-scenario score, axis breakdown, and trace event
 * counts. Verbose trace is included in JSON only (markdown stays scannable).
 */

import { passTier } from "./scorer.ts";
import type { BenchmarkReport, ScenarioResult } from "./types.ts";

export function aggregateScore(results: readonly ScenarioResult[]): {
  aggregate: number;
  judgeBonus: number;
  finalScore: number;
} {
  let weightedSum = 0;
  let weightTotal = 0;
  let boundaryPenalty = 0;
  let judgeBonusTotal = 0;
  let judgeBonusCap = 0;
  for (const r of results) {
    weightedSum += r.score * r.weight;
    weightTotal += r.weight;
    if (r.boundaryViolated) boundaryPenalty += 5;
    if (r.judge) {
      judgeBonusCap += 5;
      if (r.judge.pass) judgeBonusTotal += 1;
    }
  }
  const aggregate = weightTotal === 0 ? 0 : (100 * weightedSum) / weightTotal;
  // Normalize judge bonus to a fixed +5 cap (regardless of scenario count).
  const judgeBonus =
    judgeBonusCap === 0
      ? 0
      : (5 * judgeBonusTotal) / Math.max(1, results.length);
  const finalScore = Math.max(0, aggregate - boundaryPenalty + judgeBonus);
  return { aggregate, judgeBonus, finalScore };
}

export function buildReport(args: {
  results: ScenarioResult[];
  mode: "scripted" | "cerebras";
  model?: string;
  startedAt: string;
  finishedAt: string;
}): BenchmarkReport {
  const { results, mode, model, startedAt, finishedAt } = args;
  const { aggregate, judgeBonus, finalScore } = aggregateScore(results);
  return {
    startedAt,
    finishedAt,
    mode,
    model,
    aggregate,
    judgeBonus,
    finalScore,
    passTier: passTier(finalScore),
    scenarios: results,
  };
}

export function renderMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push("# InterruptBench Report");
  lines.push("");
  lines.push(`- Mode: ${report.mode}`);
  if (report.model) lines.push(`- Model: ${report.model}`);
  lines.push(`- Started: ${report.startedAt}`);
  lines.push(`- Finished: ${report.finishedAt}`);
  lines.push(`- Aggregate: **${report.aggregate.toFixed(2)}**`);
  lines.push(`- Judge bonus: ${report.judgeBonus.toFixed(2)}`);
  lines.push(`- Final score: **${report.finalScore.toFixed(2)}**`);
  lines.push(`- Pass tier: **${report.passTier}**`);
  lines.push("");
  lines.push("## Per-scenario");
  lines.push("");
  lines.push(
    "| ID | Category | Weight | Score | Boundary | State | Intent | Routing | Trace | Latency | Judge |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of report.scenarios) {
    const judgeCell = r.judge ? (r.judge.pass ? "PASS" : "fail") : "—";
    lines.push(
      `| ${r.scenarioId} | ${r.category} | ${r.weight} | ${(r.score * 100).toFixed(1)} | ${r.boundaryViolated ? "VIOLATED" : "ok"} | ${(r.axes.state.raw * 100).toFixed(0)} | ${(r.axes.intent.raw * 100).toFixed(0)} | ${(r.axes.routing.raw * 100).toFixed(0)} | ${(r.axes.trace.raw * 100).toFixed(0)} | ${(r.axes.latency.raw * 100).toFixed(0)} | ${judgeCell} |`,
    );
  }
  lines.push("");
  lines.push("## Notes (per scenario)");
  for (const r of report.scenarios) {
    const noteBlock: string[] = [];
    for (const axisName of [
      "state",
      "intent",
      "routing",
      "trace",
      "boundary",
      "latency",
    ] as const) {
      const ax = r.axes[axisName];
      if (ax.notes.length > 0) {
        for (const n of ax.notes) noteBlock.push(`  - [${axisName}] ${n}`);
      }
    }
    if (r.judge && !r.judge.pass) {
      noteBlock.push(`  - [judge] ${r.judge.reason}`);
    }
    if (noteBlock.length > 0) {
      lines.push("");
      lines.push(`### ${r.scenarioId}`);
      lines.push(...noteBlock);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderJson(report: BenchmarkReport): string {
  return JSON.stringify(report, null, 2);
}
