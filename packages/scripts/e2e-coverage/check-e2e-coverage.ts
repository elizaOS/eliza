#!/usr/bin/env bun
/**
 * Reports which plugin surfaces have credential-free deterministic scenarios.
 *
 * This inventory is diagnostic: it gives maintainers a current coverage map
 * without turning an historical baseline or minimum count into merge policy.
 *
 * Usage:
 *   bun packages/scripts/e2e-coverage/check-e2e-coverage.ts
 *   bun packages/scripts/e2e-coverage/check-e2e-coverage.ts --list-uncovered
 *   bun packages/scripts/e2e-coverage/check-e2e-coverage.ts --json
 *
 * Exit code: 0 after a successful inventory scan.
 */

import { buildPluginCoverage, type PluginCoverage } from "./inventory.ts";

export interface KeylessCoverageReport {
  covered: string[];
  uncovered: string[];
}

export function buildKeylessCoverageReport(
  coverage: PluginCoverage[],
): KeylessCoverageReport {
  const surfacePlugins = coverage.filter((entry) => entry.hasSurface);
  return {
    covered: surfacePlugins
      .filter((entry) => entry.hasKeylessE2e)
      .map((entry) => entry.dir)
      .sort(),
    uncovered: surfacePlugins
      .filter((entry) => !entry.hasKeylessE2e)
      .map((entry) => entry.dir)
      .sort(),
  };
}

function main(): number {
  const args = process.argv.slice(2);
  const report = buildKeylessCoverageReport(buildPluginCoverage());

  if (args.includes("--list-uncovered")) {
    process.stdout.write(`${JSON.stringify(report.uncovered, null, 2)}\n`);
    return 0;
  }

  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(
    `[e2e-coverage] ${report.covered.length} surface plugin(s) have keyless e2e; ${report.uncovered.length} do not.\n`,
  );
  if (report.uncovered.length > 0) {
    process.stdout.write(
      `Uncovered plugin surfaces:\n  ${report.uncovered.join("\n  ")}\n`,
    );
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
