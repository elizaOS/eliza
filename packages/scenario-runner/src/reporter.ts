/**
 * JSON + stdout reporting for the scenario runner. The JSON shape is what
 * `scripts/run-scenario-benchmark.mjs` expects back (scenarios[], totalCount,
 * failedCount) plus the richer per-scenario fields we emit for humans.
 */

import { writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { logger } from "@elizaos/core";
import type { AggregateReport, ScenarioReport } from "./types.ts";

export function buildAggregate(
  scenarios: ScenarioReport[],
  providerName: string | null,
  startedAtIso: string,
  completedAtIso: string,
  runId: string,
): AggregateReport {
  const totals = {
    passed: 0,
    failed: 0,
    skipped: 0,
    flakyPassed: 0,
    costUsd: 0,
  };
  for (const s of scenarios) {
    if (s.status === "passed") totals.passed += 1;
    else if (s.status === "failed") totals.failed += 1;
    else totals.skipped += 1;
  }
  return {
    runId,
    startedAtIso,
    completedAtIso,
    providerName,
    scenarios,
    totals,
    totalCount: scenarios.length,
    passedCount: totals.passed,
    failedCount: totals.failed,
    skippedCount: totals.skipped,
    flakyPassedCount: totals.flakyPassed,
    totalCostUsd: totals.costUsd,
  };
}

export function writeReport(report: AggregateReport, filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(report, null, 2), "utf-8");
  logger.info(`[scenario-runner] wrote report → ${filePath}`);
}

function scenarioReportFileName(id: string, index: number): string {
  const sanitizedId = id.replace(/[^A-Za-z0-9._-]+/g, "_");
  return `${String(index + 1).padStart(3, "0")}-${sanitizedId}.json`;
}

export function writeReportBundle(
  report: AggregateReport,
  reportDir: string,
): void {
  mkdirSync(reportDir, { recursive: true });

  const matrixPath = path.join(reportDir, "matrix.json");
  writeFileSync(matrixPath, JSON.stringify(report, null, 2), "utf-8");

  report.scenarios.forEach((scenarioReport, index) => {
    const scenarioPath = path.join(
      reportDir,
      scenarioReportFileName(scenarioReport.id, index),
    );
    writeFileSync(
      scenarioPath,
      JSON.stringify(scenarioReport, null, 2),
      "utf-8",
    );
  });

  logger.info(`[scenario-runner] wrote report bundle → ${reportDir}`);
}

export function printStdoutSummary(report: AggregateReport): void {
  const lines: string[] = [];
  lines.push("");
  lines.push(
    `Scenario run ${report.runId} | provider=${report.providerName ?? "(none)"} | ${report.startedAtIso} → ${report.completedAtIso}`,
  );
  lines.push("| id | status | duration | failures |");
  lines.push("| --- | --- | --- | --- |");
  for (const s of report.scenarios) {
    const first =
      s.failedAssertions[0]?.detail ?? s.error ?? s.skipReason ?? "";
    const detail = first
      .replace(/\\/g, "\\\\")
      .replace(/\|/g, "\\|")
      .replace(/\n/g, " ")
      .slice(0, 140);
    lines.push(`| ${s.id} | ${s.status} | ${s.durationMs}ms | ${detail} |`);
  }
  lines.push("");
  lines.push(
    `Totals: ${report.totals.passed} passed, ${report.totals.failed} failed, ${report.totals.skipped} skipped of ${report.totalCount}`,
  );
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
}
