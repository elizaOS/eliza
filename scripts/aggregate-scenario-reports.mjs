#!/usr/bin/env node
/**
 * Aggregate per-shard scenario reports into a single Markdown summary suitable
 * for appending to `$GITHUB_STEP_SUMMARY`. Expects a directory containing
 * `matrix.json` files (one per shard) and individual `<scenarioId>.json`
 * files produced by `@elizaos/scenario-runner`.
 *
 * Usage:
 *   bun run scripts/aggregate-scenario-reports.mjs <reportDir>
 */

import fs from "node:fs/promises";
import path from "node:path";

const reportDir = process.argv[2];
if (!reportDir) {
  console.error("usage: aggregate-scenario-reports.mjs <reportDir>");
  process.exit(2);
}

async function walk(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(p)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      out.push(p);
    }
  }
  return out;
}

const paths = await walk(reportDir).catch(() => []);
if (paths.length === 0) {
  console.log(`## Scenario Matrix\n\nNo reports found under ${reportDir}.`);
  process.exit(0);
}

const matrixReports = [];
const scenarioReports = [];
for (const p of paths) {
  try {
    const text = await fs.readFile(p, "utf8");
    const data = JSON.parse(text);
    if (data && typeof data === "object" && Array.isArray(data.scenarios)) {
      matrixReports.push({ path: p, ...data });
    } else if (
      data &&
      typeof data === "object" &&
      typeof data.id === "string"
    ) {
      scenarioReports.push({ path: p, ...data });
    }
  } catch {
    // Skip invalid files — corrupted artifacts should not crash aggregation.
  }
}

const totals = {
  total: 0,
  passed: 0,
  failed: 0,
  flakyPassed: 0,
  skipped: 0,
  costUsd: 0,
};
for (const m of matrixReports) {
  totals.total += Number(m.totalCount ?? 0);
  totals.passed += Number(m.passedCount ?? m.totals?.passed ?? 0);
  totals.failed += Number(m.failedCount ?? 0);
  totals.flakyPassed += Number(m.flakyPassedCount ?? 0);
  totals.skipped += Number(m.skippedCount ?? m.totals?.skipped ?? 0);
  totals.costUsd += Number(m.totalCostUsd ?? 0);
}

const failures = scenarioReports.filter((r) => r.status === "failed");
const skipped = scenarioReports.filter((r) => r.status === "skipped");

const lines = [];
lines.push("## Scenario Matrix");
lines.push("");
lines.push(
  `- ✅ ${totals.passed}   ⚠️ ${totals.flakyPassed}   ❌ ${totals.failed}   ⏭️ ${totals.skipped}   / ${totals.total}`,
);
lines.push(`- LLM cost: $${totals.costUsd.toFixed(4)}`);
lines.push("");

if (failures.length > 0) {
  lines.push("### Failures");
  lines.push("");
  for (const f of failures) {
    lines.push(`- ❌ **${f.id}** — ${f.error ?? "see report"}`);
    for (const check of f.finalChecks ?? []) {
      if (check.status === "failed") {
        lines.push(`  - finalCheck ${check.label}: ${check.detail}`);
      }
    }
  }
  lines.push("");
}

if (skipped.length > 0 && skipped.length <= 20) {
  lines.push("### Skipped");
  lines.push("");
  for (const s of skipped) {
    lines.push(`- ⏭️ ${s.id} — ${s.skipReason ?? ""}`);
  }
} else if (skipped.length > 20) {
  lines.push(`### Skipped — ${skipped.length} scenarios (details in artifact)`);
}

console.log(lines.join("\n"));
