#!/usr/bin/env node
/**
 * Emits the complete dynamic-view build inventory as reviewable machine evidence.
 *
 * The build and import guards consume the same workspace/config discovery; this
 * wrapper records only repository-relative targets so reports remain portable
 * across Linux, macOS, Windows, local worktrees, and hosted CI.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  atomicWriteJsonSync,
  resolveReportArtifactPath,
} from "./lib/report-artifact-path.mjs";
import {
  discoverViewBundleInventory,
  serializeViewBundleInventory,
} from "./lib/view-bundle-inventory.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const DEFAULT_OUTPUT = "reports/view-bundle-inventory.json";

export function parseViewInventoryArgs(args) {
  let json = false;
  let output = DEFAULT_OUTPUT;
  let outputSeen = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      if (json) throw new Error("--json may be specified only once");
      json = true;
      continue;
    }
    if (arg === "--output") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--output requires a file path");
      }
      if (outputSeen) {
        throw new Error("--output may be specified only once");
      }
      outputSeen = true;
      output = resolveReportArtifactPath(REPO_ROOT, value, {
        extension: ".json",
        label: "--output",
      }).relative;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      if (help) throw new Error("help may be specified only once");
      help = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (help && (json || outputSeen)) {
    throw new Error("help cannot be combined with output arguments");
  }
  return { help, json, output };
}

function writeJson(file, value) {
  const { absolute } = resolveReportArtifactPath(REPO_ROOT, file, {
    extension: ".json",
    label: "--output",
  });
  mkdirSync(path.dirname(absolute), { recursive: true });
  atomicWriteJsonSync(absolute, value);
}

function printUsage() {
  process.stdout.write(
    "Usage: node packages/scripts/audit-view-bundle-inventory.mjs [--json] [--output <path>]\n",
  );
}

function main() {
  const options = parseViewInventoryArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  const inventory = serializeViewBundleInventory(
    discoverViewBundleInventory({ repoRoot: REPO_ROOT }),
  );
  writeJson(options.output, inventory);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `[view-inventory] ${inventory.discoveredCount} target(s), ${inventory.excludedCount} exclusion(s); wrote ${options.output}\n`,
  );
}

if (import.meta.main || process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    // error-policy:J1 the CLI boundary converts invalid or incomplete
    // discovery into a non-zero audit result.
    process.stderr.write(
      `[view-inventory] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
