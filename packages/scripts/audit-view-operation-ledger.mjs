#!/usr/bin/env node
/** Emits and enforces the production-derived view operation ledger. */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  atomicWriteFileSync,
  atomicWriteJsonSync,
  resolveReportArtifactPath,
} from "./lib/report-artifact-path.mjs";
import {
  discoverViewOperationLedger,
  renderViewOperationLedgerMarkdown,
} from "./lib/view-operation-ledger.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const DEFAULT_JSON_OUTPUT = "reports/view-operation-ledger.json";
const DEFAULT_MARKDOWN_OUTPUT = "reports/view-operation-ledger.md";

export function parseViewOperationLedgerArgs(args) {
  let stdout = "summary";
  let jsonOutput = DEFAULT_JSON_OUTPUT;
  let markdownOutput = DEFAULT_MARKDOWN_OUTPUT;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json" || arg === "--markdown") {
      if (stdout !== "summary")
        throw new Error("--json and --markdown are mutually exclusive");
      stdout = arg.slice(2);
      continue;
    }
    if (arg === "--output" || arg === "--markdown-output") {
      const value = args[index + 1];
      if (!value || value.startsWith("-"))
        throw new Error(`${arg} requires a file path`);
      const isMarkdown = arg === "--markdown-output";
      const resolved = resolveReportArtifactPath(REPO_ROOT, value, {
        extension: isMarkdown ? ".md" : ".json",
        label: arg,
      });
      if (isMarkdown) markdownOutput = resolved.relative;
      else jsonOutput = resolved.relative;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { stdout, jsonOutput, markdownOutput, help };
}

function artifactPath(value, extension, label) {
  const resolved = resolveReportArtifactPath(REPO_ROOT, value, {
    extension,
    label,
  });
  mkdirSync(path.dirname(resolved.absolute), { recursive: true });
  return resolved;
}

function main() {
  const options = parseViewOperationLedgerArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node packages/scripts/audit-view-operation-ledger.mjs [--json|--markdown] [--output <reports/*.json>] [--markdown-output <reports/*.md>]\n",
    );
    return;
  }
  const ledger = discoverViewOperationLedger({ repoRoot: REPO_ROOT });
  const markdown = renderViewOperationLedgerMarkdown(ledger);
  const jsonArtifact = artifactPath(options.jsonOutput, ".json", "--output");
  const markdownArtifact = artifactPath(
    options.markdownOutput,
    ".md",
    "--markdown-output",
  );
  atomicWriteJsonSync(jsonArtifact.absolute, ledger);
  atomicWriteFileSync(markdownArtifact.absolute, markdown);
  if (options.stdout === "json")
    process.stdout.write(`${JSON.stringify(ledger, null, 2)}\n`);
  else if (options.stdout === "markdown") process.stdout.write(markdown);
  else {
    process.stdout.write(
      `[view-operation-ledger] ${ledger.operationCount} operation(s) across ${ledger.surfaceCount} surface(s); wrote ${jsonArtifact.relative} and ${markdownArtifact.relative}\n`,
    );
  }
}

if (import.meta.main || process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    // error-policy:J1 the CLI converts ledger drift into one explicit non-zero audit.
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
