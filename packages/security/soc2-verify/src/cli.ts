#!/usr/bin/env bun
/**
 * CLI entrypoint for running SOC2 control verification and writing evidence reports.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  defaultOutDir,
  hasCriticalFailures,
  runVerification,
  writeReport,
} from "./index.js";

interface Args {
  out?: string;
  strictFail: boolean;
  include: string[];
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { strictFail: false, include: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--strict-fail") args.strictFail = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--out") {
      const v = argv[i + 1];
      if (v !== undefined && v.length > 0 && !v.startsWith("-")) {
        args.out = v;
        i++;
      }
    } else if (a.startsWith("--out=")) {
      const v = a.slice("--out=".length);
      if (v.length > 0) args.out = v;
    } else if (a === "--include") {
      const v = argv[i + 1];
      if (v !== undefined && v.length > 0 && !v.startsWith("-")) {
        args.include.push(v);
        i++;
      }
    } else if (a.startsWith("--include=")) {
      const v = a.slice("--include=".length);
      if (v.length > 0) args.include.push(v);
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    `@elizaos/soc2-verify — SOC2 control-verification harness

Usage:
  bun run packages/security/soc2-verify/src/cli.ts [options]

Options:
  --out <dir>           Output directory (default: ./.soc2-evidence/<timestamp>)
  --strict-fail         Exit non-zero if any critical-severity check fails
  --include <substr>    Only run checks whose id contains <substr> (repeatable)
  -h, --help            Show this help

Outputs:
  <out>/evidence-report.json  (machine-readable, GRC-tool friendly)
  <out>/evidence-report.md    (human-readable, for auditor sampling)

Environment:
  SOC2_OUTER_ROOT      Override the parent repo root that hosts deploy/ and apps/.
`,
  );
}

/**
 * Find the eliza monorepo root by walking up from the CLI script location
 * until we see a `packages/security/` directory. The outer workspace root is the
 * parent of `eliza/`.
 */
function locateRoots(): { elizaRoot: string; outerRoot: string } {
  const outerRootOverride = process.env.SOC2_OUTER_ROOT
    ? resolve(process.env.SOC2_OUTER_ROOT)
    : undefined;
  let cur = dirname(new URL(import.meta.url).pathname);
  // soc2-verify/src -> soc2-verify -> security -> packages -> eliza
  for (let i = 0; i < 6; i++) {
    if (
      existsSync(join(cur, "packages/security")) &&
      existsSync(join(cur, "packages/core"))
    ) {
      const outer = outerRootOverride ?? resolve(cur, "..");
      return { elizaRoot: cur, outerRoot: outer };
    }
    cur = dirname(cur);
  }
  // fallback: cwd
  return {
    elizaRoot: process.cwd(),
    outerRoot: outerRootOverride ?? resolve(process.cwd(), ".."),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const { elizaRoot, outerRoot } = locateRoots();
  const outDir = args.out ?? defaultOutDir(join(elizaRoot, ".soc2-evidence"));

  const report = await runVerification({
    elizaRoot,
    outerRoot,
    strictFail: args.strictFail,
    ...(args.include.length > 0 ? { include: args.include } : {}),
  });
  const { jsonPath, mdPath } = writeReport(report, { outDir });

  const { pass, fail, warn, skip, readiness_score } = report.overall;
  process.stdout.write(
    `\n[soc2-verify] pass=${pass} fail=${fail} warn=${warn} skip=${skip} readiness=${(readiness_score * 100).toFixed(1)}%\n`,
  );
  process.stdout.write(`[soc2-verify] wrote ${jsonPath}\n`);
  process.stdout.write(`[soc2-verify] wrote ${mdPath}\n`);

  if (args.strictFail && hasCriticalFailures(report)) {
    process.stdout.write(
      `[soc2-verify] CRITICAL failures present — exiting non-zero (--strict-fail).\n`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(
    `[soc2-verify] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(2);
});
