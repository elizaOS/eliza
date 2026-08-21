#!/usr/bin/env node
/**
 * Exposes the exact-13 provider readiness doctor as an offline CLI. All fatal
 * output is constant so malformed private configuration cannot reach logs.
 */

import process from "node:process";
import {
  inspectExact13ProviderReadiness,
  providerReadinessReportSha256,
  writeProviderReadinessReport,
} from "./provider-readiness-doctor.ts";

export const PROVIDER_READINESS_HELP = `Usage:
  eliza-provider-readiness <exact13-config.json> --operator-config <reference-operator-config.json> --output <new-directory>
  eliza-provider-readiness --help

Validates the canonical 13 prepared canaries and deployment inventory entirely
offline. It never evaluates the operator module, resolves secret references,
contacts providers or services, or claims qualification evidence.

Exit codes:
  0  all 13 configurations are ready for an operator-controlled live run
  1  at least one canary has missing or invalid prerequisites
  2  invocation or top-level audit failure
`;

function flag(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  if (
    index < 0 ||
    index === args.length - 1 ||
    args[index + 1].startsWith("--")
  ) {
    throw new Error(`missing required ${name}`);
  }
  return args[index + 1];
}

export async function runProviderReadinessCli(
  argv: readonly string[],
  io: { stdout(value: string): void } = {
    stdout: (value) => process.stdout.write(value),
  },
): Promise<number> {
  if (
    argv.length === 0 ||
    argv[0] === "--help" ||
    argv[0] === "-h" ||
    argv[0] === "help"
  ) {
    io.stdout(PROVIDER_READINESS_HELP);
    return 0;
  }
  const exact13ConfigFile = argv[0];
  if (exact13ConfigFile.startsWith("--"))
    throw new Error("missing exact13 config path");
  const allowed = new Set(["--operator-config", "--output"]);
  for (const [index, arg] of argv.slice(1).entries()) {
    if (arg.startsWith("--") && !allowed.has(arg))
      throw new Error(`unsupported flag ${arg}`);
    if (
      !arg.startsWith("--") &&
      (index === 0 || !argv[index].startsWith("--"))
    ) {
      throw new Error("unexpected positional argument");
    }
  }
  const referenceOperatorConfigFile = flag(argv, "--operator-config");
  const outputDirectory = flag(argv, "--output");
  const report = await inspectExact13ProviderReadiness({
    exact13ConfigFile,
    referenceOperatorConfigFile,
  });
  writeProviderReadinessReport({ report, outputDirectory });
  io.stdout(
    `${JSON.stringify({ status: report.status, ready: report.summary.ready, missing: report.summary.missing, invalid: report.summary.invalid, reportSha256: providerReadinessReportSha256(report), outputDirectory })}\n`,
  );
  return report.status === "ready" ? 0 : 1;
}

if (import.meta.main) {
  runProviderReadinessCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      // error-policy:J1 Private audit failures use a constant CLI boundary.
      process.stderr.write("eliza-provider-readiness: offline audit failed\n");
      process.exitCode = 2;
    },
  );
}
