import type {
  HandlerResult,
  BenchmarkResults,
  ScenarioScore,
} from "../types.js";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

export const G = "\x1b[32m";
export const R = "\x1b[31m";
export const Y = "\x1b[33m";
export const B = "\x1b[1m";
const D = "\x1b[2m";
export const X = "\x1b[0m";

function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function statusColor(score: number): string {
  if (score >= 90) return G;
  if (score >= 60) return Y;
  return R;
}

function checkIcon(passed: boolean): string {
  return passed ? `${G}✓${X}` : `${R}✗${X}`;
}

export function header(text: string): void {
  console.log(`\n${"═".repeat(90)}\n  ${B}${text}${X}\n${"═".repeat(90)}\n`);
}

export function printHandlerResult(result: HandlerResult): void {
  header(`${result.handlerName}`);

  const overallColor = statusColor(result.overallScore);
  const secColor = statusColor(result.securityScore);
  const capColor = statusColor(result.capabilityScore);

  console.log(`  Overall: ${overallColor}${pct(result.overallScore)}${X}  |  Security: ${secColor}${pct(result.securityScore)}${X}  |  Capability: ${capColor}${pct(result.capabilityScore)}${X}  |  Time: ${result.totalTimeMs.toFixed(0)}ms\n`);

  console.log(`  ${"Category".padEnd(20)} ${"Passed".padEnd(12)} ${"Avg Score".padEnd(12)} ${"Violations".padEnd(12)}`);
  console.log(`  ${"─".repeat(56)}`);
  for (const cat of result.categories) {
    const catColor = statusColor(cat.averageScore * 100);
    const violations = cat.securityViolations > 0 ? `${R}${cat.securityViolations}${X}` : `${G}0${X}`;
    console.log(`  ${cat.category.padEnd(20)} ${`${cat.passedCount}/${cat.scenarioCount}`.padEnd(12)} ${catColor}${pct(cat.averageScore * 100).padEnd(12)}${X} ${violations}`);
  }
  console.log("");

  for (const scenario of result.scenarios) {
    printScenarioResult(scenario);
  }
}

function printScenarioResult(scenario: ScenarioScore): void {
  const icon = scenario.passed ? `${G}PASS${X}` : `${R}FAIL${X}`;
  const secFlag = scenario.securityViolation ? ` ${R}[SECURITY VIOLATION]${X}` : "";
  console.log(`  ┌── ${B}${scenario.scenarioId}${X}: ${scenario.scenarioName} ${icon} (${pct(scenario.score * 100)})${secFlag}`);

  for (const check of scenario.checks) {
    const ci = checkIcon(check.passed);
    const sev = check.severity === "critical" ? `${R}[CRIT]${X}` : check.severity === "major" ? `${Y}[MAJ]${X}` : `${D}[MIN]${X}`;
    if (!check.passed) {
      console.log(`  │ ${ci} ${sev} ${check.name}`);
      console.log(`  │   ${D}Expected: ${check.expected}${X}`);
      console.log(`  │   ${D}Actual:   ${check.actual}${X}`);
    } else {
      console.log(`  │ ${ci} ${check.name}`);
    }
  }

  if (scenario.traces.length > 0) {
    console.log(`  │`);
    for (const trace of scenario.traces.slice(0, 5)) {
      console.log(`  │ ${D}→ ${trace}${X}`);
    }
    if (scenario.traces.length > 5) {
      console.log(`  │ ${D}→ ... (${scenario.traces.length - 5} more)${X}`);
    }
  }

  console.log(`  └──\n`);
}

export function printComparison(results: HandlerResult[]): void {
  header("COMPARISON");

  const h = `  ${"Handler".padEnd(28)} ${"Overall".padEnd(10)} ${"Security".padEnd(10)} ${"Capability".padEnd(12)} ${"Time".padEnd(10)}`;
  console.log(h);
  console.log(`  ${"─".repeat(70)}`);

  for (const r of results) {
    const oColor = statusColor(r.overallScore);
    const sColor = statusColor(r.securityScore);
    const cColor = statusColor(r.capabilityScore);
    console.log(
      `  ${r.handlerName.substring(0, 27).padEnd(28)} ` +
      `${oColor}${pct(r.overallScore).padEnd(10)}${X} ` +
      `${sColor}${pct(r.securityScore).padEnd(10)}${X} ` +
      `${cColor}${pct(r.capabilityScore).padEnd(12)}${X} ` +
      `${r.totalTimeMs.toFixed(0)}ms`
    );
  }
  console.log("");
}

export function writeJsonResults(results: BenchmarkResults, outputDir: string): string {
  mkdirSync(outputDir, { recursive: true });
  const filename = `configbench-results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const filepath = join(outputDir, filename);

  writeFileSync(filepath, JSON.stringify(results, null, 2));
  return filepath;
}

export function writeMarkdownReport(results: BenchmarkResults, outputDir: string): string {
  mkdirSync(outputDir, { recursive: true });
  const filename = `configbench-report-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
  const filepath = join(outputDir, filename);

  const lines: string[] = [];

  lines.push("# ConfigBench Results");
  lines.push("");
  lines.push(`**Date:** ${results.timestamp}`);
  lines.push(`**Total Scenarios:** ${results.totalScenarios}`);
  lines.push(`**Validation:** ${results.validationPassed ? "PASSED (Perfect handler = 100%)" : "FAILED"}`);
  lines.push("");

  lines.push("## Handler Comparison");
  lines.push("");
  lines.push("| Handler | Overall | Security | Capability | Time |");
  lines.push("|---------|---------|----------|------------|------|");
  for (const h of results.handlers) {
    lines.push(`| ${h.handlerName} | ${pct(h.overallScore)} | ${pct(h.securityScore)} | ${pct(h.capabilityScore)} | ${h.totalTimeMs.toFixed(0)}ms |`);
  }
  lines.push("");

  for (const handler of results.handlers) {
    lines.push(`## ${handler.handlerName}`);
    lines.push("");

    // Category breakdown
    lines.push("### Category Breakdown");
    lines.push("");
    lines.push("| Category | Passed | Avg Score | Security Violations |");
    lines.push("|----------|--------|-----------|---------------------|");
    for (const cat of handler.categories) {
      lines.push(`| ${cat.category} | ${cat.passedCount}/${cat.scenarioCount} | ${pct(cat.averageScore * 100)} | ${cat.securityViolations} |`);
    }
    lines.push("");

    const failed = handler.scenarios.filter(s => !s.passed);
    if (failed.length > 0) {
      lines.push("### Failed Scenarios");
      lines.push("");
      for (const s of failed) {
        const secFlag = s.securityViolation ? " **[SECURITY VIOLATION]**" : "";
        lines.push(`#### ${s.scenarioId}: ${s.scenarioName}${secFlag}`);
        lines.push("");
        lines.push(`Score: ${pct(s.score * 100)}`);
        lines.push("");
        for (const check of s.checks.filter(c => !c.passed)) {
          lines.push(`- **[${check.severity.toUpperCase()}]** ${check.name}`);
          lines.push(`  - Expected: ${check.expected}`);
          lines.push(`  - Actual: ${check.actual}`);
        }
        lines.push("");
      }
    }

    const passed = handler.scenarios.filter(s => s.passed);
    if (passed.length > 0) {
      lines.push("### Passed Scenarios");
      lines.push("");
      for (const s of passed) {
        lines.push(`- **${s.scenarioId}**: ${s.scenarioName} (${pct(s.score * 100)})`);
      }
      lines.push("");
    }
  }

  writeFileSync(filepath, lines.join("\n"));
  return filepath;
}
