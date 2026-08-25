#!/usr/bin/env node
/** Emits and enforces the authoritative first-party runtime-view inventory. */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverPluginViewInventory,
  renderPluginViewInventoryMarkdown,
  serializePluginViewInventory,
} from "./lib/plugin-view-inventory.mjs";
import {
  atomicWriteFileSync,
  atomicWriteJsonSync,
  resolveReportArtifactPath,
} from "./lib/report-artifact-path.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const DEFAULT_JSON_OUTPUT = "reports/plugin-view-inventory.json";
const DEFAULT_MARKDOWN_OUTPUT = "reports/plugin-view-inventory.md";

export function parsePluginViewInventoryArgs(args) {
  let stdout = "summary";
  let jsonOutput = DEFAULT_JSON_OUTPUT;
  let markdownOutput = DEFAULT_MARKDOWN_OUTPUT;
  let jsonOutputSeen = false;
  let markdownOutputSeen = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json" || arg === "--markdown") {
      if (stdout !== "summary") {
        throw new Error("--json and --markdown are mutually exclusive");
      }
      stdout = arg.slice(2);
      continue;
    }
    if (arg === "--output" || arg === "--markdown-output") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`${arg} requires a file path`);
      }
      const isMarkdown = arg === "--markdown-output";
      if (isMarkdown ? markdownOutputSeen : jsonOutputSeen) {
        throw new Error(`${arg} may be specified only once`);
      }
      const resolved = resolveReportArtifactPath(REPO_ROOT, value, {
        extension: isMarkdown ? ".md" : ".json",
        label: arg,
      });
      if (isMarkdown) {
        markdownOutputSeen = true;
        markdownOutput = resolved.relative;
      } else {
        jsonOutputSeen = true;
        jsonOutput = resolved.relative;
      }
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
  if (help && (stdout !== "summary" || jsonOutputSeen || markdownOutputSeen)) {
    throw new Error("help cannot be combined with output arguments");
  }
  return { help, stdout, jsonOutput, markdownOutput };
}

function artifactPath(value, extension, label) {
  const resolved = resolveReportArtifactPath(REPO_ROOT, value, {
    extension,
    label,
  });
  mkdirSync(path.dirname(resolved.absolute), { recursive: true });
  return resolved;
}

function printUsage() {
  process.stdout.write(
    "Usage: node packages/scripts/audit-plugin-view-inventory.mjs [--json|--markdown] [--output <reports/*.json>] [--markdown-output <reports/*.md>]\n",
  );
}

function main() {
  const options = parsePluginViewInventoryArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  const serialized = serializePluginViewInventory(
    discoverPluginViewInventory({ repoRoot: REPO_ROOT }),
  );
  const markdown = renderPluginViewInventoryMarkdown(serialized);
  const jsonArtifact = artifactPath(options.jsonOutput, ".json", "--output");
  const markdownArtifact = artifactPath(
    options.markdownOutput,
    ".md",
    "--markdown-output",
  );
  atomicWriteJsonSync(jsonArtifact.absolute, serialized);
  atomicWriteFileSync(markdownArtifact.absolute, markdown);

  if (options.stdout === "json") {
    process.stdout.write(`${JSON.stringify(serialized, null, 2)}\n`);
  } else if (options.stdout === "markdown") {
    process.stdout.write(markdown);
  } else {
    process.stdout.write(
      `[plugin-view-inventory] ${serialized.discoveredCount} view(s) from ${serialized.declarationSourceCount} source(s): ${serialized.builtinCount} built-in, ${serialized.pluginCount} plugin; wrote ${jsonArtifact.relative} and ${markdownArtifact.relative}\n`,
    );
  }
}

if (import.meta.main || process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    // error-policy:J1 the command boundary turns malformed declarations and
    // collisions into one explicit non-zero repository audit result.
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
