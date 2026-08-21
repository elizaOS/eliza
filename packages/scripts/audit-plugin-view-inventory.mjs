#!/usr/bin/env node
/** Emits and enforces the authoritative runtime view declaration inventory. */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverPluginViewInventory,
  serializePluginViewInventory,
} from "./lib/plugin-view-inventory.mjs";
import {
  atomicWriteJsonSync,
  resolveReportArtifactPath,
} from "./lib/report-artifact-path.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const DEFAULT_OUTPUT = "reports/plugin-view-inventory.json";

function parseArgs(args) {
  let json = false;
  let output = DEFAULT_OUTPUT;
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
      output = resolveReportArtifactPath(REPO_ROOT, value, {
        extension: ".json",
        label: "--output",
      }).relative;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { json, output };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const inventory = serializePluginViewInventory(
    discoverPluginViewInventory({ repoRoot: REPO_ROOT }),
  );
  const resolved = resolveReportArtifactPath(REPO_ROOT, options.output, {
    extension: ".json",
    label: "--output",
  });
  mkdirSync(path.dirname(resolved.absolute), { recursive: true });
  atomicWriteJsonSync(resolved.absolute, inventory);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
  } else {
    process.stdout.write(
      `[plugin-view-inventory] ${inventory.discoveredCount} declaration(s): ${inventory.builtinCount} built-in, ${inventory.pluginCount} plugin; wrote ${options.output}\n`,
    );
  }
}

if (import.meta.main || process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    // error-policy:J1 the CLI boundary turns invalid declarations and
    // collisions into a non-zero CI audit result.
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
