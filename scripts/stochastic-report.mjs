#!/usr/bin/env node
/**
 * Aggregates stochastic-results.jsonl into a tier distribution + weak-test
 * focus list. Run after `bun run test` (or any subset) when tests are using
 * `stochasticTest` from @elizaos/app-core/test/helpers/stochastic-test.
 *
 * Usage:
 *   node scripts/stochastic-report.mjs               # print summary
 *   node scripts/stochastic-report.mjs --weak-only   # only the focus list
 *   node scripts/stochastic-report.mjs --json        # machine-readable
 *   node scripts/stochastic-report.mjs --reset       # delete the jsonl
 *
 * Env:
 *   ELIZA_STOCHASTIC_REPORT_DIR  (default: <repo root>/.eliza)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as process from "node:process";

const repoRoot = process.cwd();
const reportDir =
  process.env.ELIZA_STOCHASTIC_REPORT_DIR ?? path.join(repoRoot, ".eliza");
const reportFile = path.join(reportDir, "stochastic-results.jsonl");

const args = new Set(process.argv.slice(2));
const flagWeakOnly = args.has("--weak-only");
const flagJson = args.has("--json");
const flagReset = args.has("--reset");

if (flagReset) {
  if (fs.existsSync(reportFile)) {
    fs.rmSync(reportFile);
    console.error(`removed ${reportFile}`);
  }
  process.exit(0);
}

if (!fs.existsSync(reportFile)) {
  console.error(
    `No stochastic results at ${reportFile}. Run tests using stochasticTest first.`,
  );
  process.exit(0);
}

const lines = fs
  .readFileSync(reportFile, "utf-8")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

/** @type {Map<string, { file: string; name: string; label: string; runs: number; passed: number; failed: number; tier: string; errors: string[]; durationMs: number; ts: number }>} */
const latest = new Map();
for (const line of lines) {
  try {
    const record = JSON.parse(line);
    if (
      typeof record?.file !== "string" ||
      typeof record?.name !== "string" ||
      typeof record?.runs !== "number" ||
      typeof record?.passed !== "number"
    ) {
      continue;
    }
    const key = `${record.file}::${record.name}`;
    const existing = latest.get(key);
    if (!existing || (record.ts ?? 0) > (existing.ts ?? 0)) {
      latest.set(key, record);
    }
  } catch {
    // Ignore malformed lines.
  }
}

const records = [...latest.values()];
if (records.length === 0) {
  console.error("No parseable results.");
  process.exit(0);
}

const tierOrder = (tier) => {
  const [passed, runs] = tier
    .split("/")
    .map((value) => Number.parseInt(value, 10));
  if (!Number.isFinite(passed) || !Number.isFinite(runs)) return -1;
  return passed * 1000 + runs;
};

const tierCounts = new Map();
for (const record of records) {
  tierCounts.set(record.tier, (tierCounts.get(record.tier) ?? 0) + 1);
}

const sortedTiers = [...tierCounts.entries()].sort(
  (a, b) => tierOrder(b[0]) - tierOrder(a[0]),
);

const totalTests = records.length;
const weak = records.filter((record) => record.passed < record.runs);
const focus = records
  .filter((record) => record.passed < Math.ceil((record.runs * 2) / 3))
  .sort((a, b) => a.passed - b.passed || b.failed - a.failed);

if (flagJson) {
  console.log(
    JSON.stringify(
      {
        totalTests,
        tiers: Object.fromEntries(sortedTiers),
        weak,
        focus,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const formatPct = (count) => {
  const pct = (count / totalTests) * 100;
  return pct >= 10 ? pct.toFixed(1) : pct.toFixed(2);
};

if (!flagWeakOnly) {
  console.log(`\nStochastic test quality (${totalTests} tests):`);
  for (const [tier, count] of sortedTiers) {
    const [passed, runs] = tier.split("/").map(Number);
    const bar = "●".repeat(passed) + "○".repeat(Math.max(0, runs - passed));
    console.log(
      `  ${bar.padEnd(5)} ${tier.padEnd(4)} ${String(count).padStart(5)}  (${formatPct(count)}%)`,
    );
  }

  if (weak.length === 0) {
    console.log("\nAll tests at full tier — nothing to focus on.");
    process.exit(0);
  }
}

if (focus.length === 0) {
  console.log("\nNo tests below 2/3. Remaining work: push 2/3 tests to 3/3.");
  if (!flagWeakOnly) {
    const flaky = records
      .filter(
        (r) => r.passed < r.runs && r.passed >= Math.ceil((r.runs * 2) / 3),
      )
      .sort((a, b) => a.passed - b.passed);
    if (flaky.length > 0) {
      console.log("\nFlaky (but above min-pass threshold):");
      for (const record of flaky.slice(0, 25)) {
        console.log(
          `  ${record.tier}  ${record.label}\n        ${record.file}`,
        );
      }
      if (flaky.length > 25) {
        console.log(`  …and ${flaky.length - 25} more`);
      }
    }
  }
  process.exit(0);
}

console.log(`\nFocus list — below 2/3 (${focus.length}):`);
for (const record of focus) {
  console.log(`  ${record.tier}  ${record.label}\n        ${record.file}`);
  if (record.errors.length > 0) {
    console.log(`        └─ ${record.errors[0]}`);
  }
}
