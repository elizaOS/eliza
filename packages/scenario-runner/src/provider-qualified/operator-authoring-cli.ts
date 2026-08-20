#!/usr/bin/env node
/**
 * Exposes non-executing init and preflight commands for private provider-canary
 * operator material. It intentionally has no credential, signer, or run flags.
 */

import process from "node:process";
import {
  PROVIDER_CANARY_SCENARIO_IDS,
  type ProviderCanaryScenarioId,
} from "./canary-catalog.ts";
import {
  initializeProviderOperatorDirectory,
  preflightProviderOperatorDirectory,
  prepareProviderCanaryRunDirectory,
} from "./operator-authoring.ts";

export const PROVIDER_OPERATOR_HELP = `Usage:
  eliza-provider-operator init <directory> --scenario <canonical-id> --scenarios <catalog-directory>
  eliza-provider-operator preflight <directory>
  eliza-provider-operator prepare-run <authoring-directory> <new-run-directory>
  eliza-provider-operator help

Commands:
  init       Create one private 0700 directory with five 0600 files; editable starters are deliberately invalid.
  preflight  Validate file modes, closed documents, one operation, two probes, and all 13 static canary snapshots.
  prepare-run Preflight, copy exact raw/HSM-authorized inputs, and write a closed v2 config without executing it.
  help       Show this help without reading or writing files.

This tool never runs provider ingress and never accepts private PEM, key-file,
credential, token, or execution flags. Authorization is available only through
the injected ProviderManifestSigner API for an offline or HSM implementation.

Canonical scenario IDs:
${PROVIDER_CANARY_SCENARIO_IDS.map((id) => `  ${id}`).join("\n")}
`;

function fail(message: string): never {
  throw new Error(`eliza-provider-operator: ${message}`);
}

function flag(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) fail(`missing required ${name}`);
  const value = args[index + 1];
  if (value.startsWith("--")) fail(`missing value for ${name}`);
  return value;
}

function rejectUnsupportedFlags(
  args: readonly string[],
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  for (const arg of args) {
    if (arg.startsWith("--") && !allowedSet.has(arg))
      fail(`unsupported flag ${arg}`);
  }
}

export async function runProviderOperatorCli(
  argv: readonly string[],
  io: { stdout(message: string): void } = {
    stdout: (message) => process.stdout.write(message),
  },
): Promise<number> {
  const [command, directory, ...rest] = argv;
  if (
    command === undefined ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    io.stdout(PROVIDER_OPERATOR_HELP);
    return 0;
  }
  if (command === "init") {
    if (!directory || directory.startsWith("--"))
      fail("init requires <directory>");
    rejectUnsupportedFlags(rest, ["--scenario", "--scenarios"]);
    const scenario = flag(rest, "--scenario");
    if (!(PROVIDER_CANARY_SCENARIO_IDS as readonly string[]).includes(scenario))
      fail(`${scenario} is not a canonical provider canary`);
    const scenarios = flag(rest, "--scenarios");
    await initializeProviderOperatorDirectory({
      directory,
      scenarioId: scenario as ProviderCanaryScenarioId,
      scenarioDirectory: scenarios,
    });
    io.stdout(
      `${JSON.stringify({ status: "initialized", directory, scenarioId: scenario })}\n`,
    );
    return 0;
  }
  if (command === "preflight") {
    if (!directory || directory.startsWith("--"))
      fail("preflight requires <directory>");
    if (rest.length > 0) fail("preflight accepts no flags or extra arguments");
    const result = await preflightProviderOperatorDirectory(directory);
    io.stdout(
      `${JSON.stringify({ status: result.status, scenarioId: result.scenarioId, operationKind: result.operation.kind, probeCount: result.probeBindings.length, inventoryCount: result.inventory.length })}\n`,
    );
    return 0;
  }
  if (command === "prepare-run") {
    if (!directory || directory.startsWith("--"))
      fail("prepare-run requires <authoring-directory>");
    const [runDirectory, ...extra] = rest;
    if (!runDirectory || runDirectory.startsWith("--") || extra.length > 0) {
      fail("prepare-run requires exactly one <new-run-directory>");
    }
    const config = await prepareProviderCanaryRunDirectory({
      authoringDirectory: directory,
      runDirectory,
    });
    io.stdout(
      `${JSON.stringify({ status: "run-config-prepared", runDirectory, configFile: "config.json", operationKind: config.operationKind })}\n`,
    );
    return 0;
  }
  fail(`unknown command ${command}; run help`);
}

if (import.meta.main) {
  runProviderOperatorCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // error-policy:J1 CLI boundary translates a refusal to stderr and exit 2.
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 2;
    },
  );
}
