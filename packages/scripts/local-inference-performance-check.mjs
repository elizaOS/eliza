#!/usr/bin/env node
/**
 * Evaluates local-inference throughput relative to a same-run baseline.
 * Backend-specific median ratios absorb runner class and machine speed while
 * positive sample and variant counts prevent empty or one-shot green reports.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function positiveSamples(row, minimum) {
  invariant(
    row?.ok === true && row.skipped !== true,
    `${row?.name ?? "variant"} did not execute successfully`,
  );
  invariant(Array.isArray(row.runs), `${row.name} has no run samples`);
  const samples = row.runs.map(({ tokPerSec }) => tokPerSec);
  invariant(
    samples.length >= minimum,
    `${row.name} has ${samples.length} samples; expected at least ${minimum}`,
  );
  invariant(
    samples.every((value) => Number.isFinite(value) && value > 0),
    `${row.name} contains non-positive throughput`,
  );
  return samples;
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

export function evaluatePerformance(report, policy) {
  const backend = report?.hardware?.backend;
  const ratios = policy?.backends?.[backend];
  invariant(
    ratios && typeof ratios === "object",
    `no performance policy for backend ${backend ?? "<missing>"}`,
  );
  invariant(Array.isArray(report.variants), "report has no variants");
  const executed = report.variants.filter(
    (row) => row.ok === true && row.skipped !== true,
  );
  invariant(
    executed.length >= policy.minimumExecutedVariants,
    `only ${executed.length} variants executed; expected at least ${policy.minimumExecutedVariants}`,
  );
  const byName = new Map(executed.map((row) => [row.name, row]));
  const baseline = byName.get(policy.baseline);
  invariant(baseline, `required baseline ${policy.baseline} did not execute`);
  const baselineMedian = median(
    positiveSamples(baseline, policy.minimumSamplesPerVariant),
  );
  const comparisons = [];
  for (const [name, minimumRatio] of Object.entries(ratios)) {
    invariant(
      Number.isFinite(minimumRatio) && minimumRatio > 0,
      `invalid ${backend}/${name} ratio`,
    );
    const row = byName.get(name);
    invariant(row, `required comparison variant ${name} did not execute`);
    const variantMedian = median(
      positiveSamples(row, policy.minimumSamplesPerVariant),
    );
    const actualRatio = variantMedian / baselineMedian;
    invariant(
      actualRatio >= minimumRatio,
      `${backend}/${name} median ratio ${actualRatio.toFixed(3)} is below ${minimumRatio.toFixed(3)}`,
    );
    comparisons.push({
      name,
      medianTokPerSec: variantMedian,
      ratio: actualRatio,
      minimumRatio,
    });
  }
  return {
    backend,
    baseline: policy.baseline,
    baselineMedianTokPerSec: baselineMedian,
    executedVariants: executed.length,
    comparisons,
  };
}

function main(argv) {
  const [reportPath, policyPath] = argv;
  invariant(
    reportPath && policyPath,
    "usage: local-inference-performance-check.mjs <report.json> <policy.json>",
  );
  const result = evaluatePerformance(
    JSON.parse(readFileSync(reportPath, "utf8")),
    JSON.parse(readFileSync(policyPath, "utf8")),
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `[local-inference-performance] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
