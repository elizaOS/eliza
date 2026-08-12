#!/usr/bin/env node
/**
 * Gate cold /login transfer samples against login-transfer-budgets.json (#18056).
 *
 * Usage:
 *   node scripts/check-login-transfer-budget.mjs \
 *     --report output-login-transfer/report.json \
 *     [--budgets login-transfer-budgets.json] \
 *     [--update-baseline]
 *
 * Missing measurement or over-budget fails. Null budget ceilings are reported
 * as missing-budget (fail closed for enforced metrics once ceilings are set;
 * while all ceilings are null the script exits 0 with a "not calibrated" note
 * so the harness can land before baselines exist).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");

function parseArgs(argv) {
  const args = {
    report: null,
    budgets: join(appDir, "login-transfer-budgets.json"),
    updateBaseline: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--report") args.report = argv[++i];
    else if (a === "--budgets") args.budgets = argv[++i];
    else if (a === "--update-baseline") args.updateBaseline = true;
  }
  return args;
}

function evaluateSample(sample, budget) {
  const findings = [];
  const checks = [
    ["maxTotalTransferBytes", "transferBytes", "baselineTotalTransferBytes"],
    ["maxScriptTransferBytes", "scriptTransferBytes", "baselineScriptTransferBytes"],
    ["maxScriptCount", "scripts", "baselineScriptCount"],
  ];
  for (const [maxKey, valueKey, baselineKey] of checks) {
    const max = budget[maxKey];
    const value = sample[valueKey];
    if (max == null) {
      findings.push({ metric: maxKey, status: "missing-budget", value });
      continue;
    }
    if (value == null || !Number.isFinite(value)) {
      findings.push({ metric: maxKey, status: "missing-metric", value });
      continue;
    }
    if (value > max) {
      findings.push({
        metric: maxKey,
        status: "over-budget",
        value,
        max,
      });
    } else {
      findings.push({ metric: maxKey, status: "pass", value, max });
    }
    const baseline = budget[baselineKey];
    if (baseline != null && Number.isFinite(baseline) && baseline > 0) {
      const pct = ((value - baseline) / baseline) * 100;
      findings.push({
        metric: `${baselineKey}:deltaPct`,
        status: "info",
        value: pct,
      });
    }
  }
  return findings;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.report) {
    console.error("Required: --report <measure-anonymous-login-transfer JSON>");
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(args.report, "utf8"));
  const budgets = JSON.parse(readFileSync(args.budgets, "utf8"));

  const allFindings = [];
  for (const viewport of ["desktop", "mobile"]) {
    const sample = report.samples?.find((s) => s.viewport === viewport);
    const budget = budgets[viewport] || {};
    if (!sample) {
      allFindings.push({
        viewport,
        findings: [{ metric: "sample", status: "missing-metric" }],
      });
      continue;
    }
    if (args.updateBaseline) {
      budget.baselineTotalTransferBytes = sample.transferBytes;
      budget.baselineScriptTransferBytes = sample.scriptTransferBytes;
      budget.baselineScriptCount = sample.scripts;
      // First calibration: set ceilings to 110% of measured (tolerance room)
      // unless already set.
      const room = 1.1;
      if (budget.maxTotalTransferBytes == null) {
        budget.maxTotalTransferBytes = Math.ceil(sample.transferBytes * room);
      }
      if (budget.maxScriptTransferBytes == null) {
        budget.maxScriptTransferBytes = Math.ceil(
          sample.scriptTransferBytes * room,
        );
      }
      if (budget.maxScriptCount == null) {
        budget.maxScriptCount = Math.ceil(sample.scripts * room);
      }
      budgets[viewport] = budget;
    }
    allFindings.push({
      viewport,
      findings: evaluateSample(sample, budget),
    });
  }

  if (args.updateBaseline) {
    writeFileSync(args.budgets, `${JSON.stringify(budgets, null, 2)}\n`);
    console.log(`Updated baselines + ceilings in ${args.budgets}`);
  }

  let hardFail = false;
  let anyCeiling = false;
  for (const block of allFindings) {
    console.log(`\n[${block.viewport}]`);
    for (const f of block.findings) {
      console.log(`  ${f.status.padEnd(16)} ${f.metric} value=${f.value ?? "n/a"}${f.max != null ? ` max=${f.max}` : ""}`);
      if (f.status === "missing-budget") {
        /* not calibrated yet */
      } else if (
        f.status === "over-budget" ||
        f.status === "missing-metric"
      ) {
        hardFail = true;
      }
      if (f.status === "pass" || f.status === "over-budget") anyCeiling = true;
    }
  }

  if (!anyCeiling && !args.updateBaseline) {
    console.log(
      "\nNo transfer ceilings calibrated yet (all max* null). Measure develop + head, then re-run with --update-baseline on the *target* baseline, or set ceilings manually.",
    );
    process.exit(0);
  }

  process.exit(hardFail ? 1 : 0);
}

main();
