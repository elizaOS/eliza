#!/usr/bin/env node

/**
 * Testing skip inventory auditor for Feed.
 * It scans source files for skipped tests and reports undocumented unconditional skips as tracked test debt.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const SKIP_PATTERN =
  /\b(?:test|it|describe)\.skip(?:If)?\s*\(|\.skipIf\s*\(|\btest\.skip\s*\(|\bdescribe\.skip\b/g;

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const IGNORED_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "storybook-static",
  "test-results",
]);

function parseArgs(argv) {
  const args = {
    format: "text",
    failOnUndocumentedUnconditional: false,
  };
  for (const arg of argv) {
    if (arg === "--format=json") args.format = "json";
    else if (arg === "--format=text") args.format = "text";
    else if (arg === "--fail-on-undocumented-unconditional") {
      args.failOnUndocumentedUnconditional = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: bun run scripts/testing-skip-inventory.mjs [options]

Options:
  --format=text|json                         Output format (default: text)
  --fail-on-undocumented-unconditional       Exit 1 when a bare unconditional skip lacks nearby rationale
`);
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      yield fullPath;
    }
  }
}

function hasQuotedReason(line) {
  return /test\.skip\s*\([^,\n]+,\s*["'`]/.test(line);
}

function contextFor(lines, lineIndex) {
  const start = Math.max(0, lineIndex - 6);
  const end = Math.min(lines.length, lineIndex + 4);
  return lines.slice(start, end).join("\n");
}

function classifySkip(line, context) {
  const haystack = `${line}\n${context}`.toLowerCase();
  if (hasQuotedReason(line)) return "documented-inline";
  if (
    /skip:\s|skipping|broken|pre-existing|unrelated|todo|fixme/.test(haystack)
  ) {
    return "documented-nearby";
  }
  if (
    /server.*(healthy|available)|healthy|base_url|playwright_base_url/.test(
      haystack,
    )
  ) {
    return "server-gated";
  }
  if (
    /live.?llm|api.?key|openai|anthropic|groq|elizacloud|model key/.test(
      haystack,
    )
  ) {
    return "live-llm-gated";
  }
  if (/database|postgres|db\b|direct_database_url/.test(haystack)) {
    return "database-gated";
  }
  if (/auth|session|api key|registration|login|wallet/.test(haystack)) {
    return "auth-or-session-gated";
  }
  if (/seed|snapshot|metamask|onchain|settlement|nft/.test(haystack)) {
    return "seed-or-external-state-gated";
  }
  if (/strict|local dev|optional/.test(haystack)) {
    return "local-optional";
  }
  if (
    /\bif\s*\(|\belse\s*\{|\?\s*describe\.skip|\?\s*test\.skip/.test(context)
  ) {
    return "conditional-undocumented";
  }
  return "undocumented-unconditional";
}

function inventoryFile(filePath) {
  const text = readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  const findings = [];
  for (const [lineIndex, line] of lines.entries()) {
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
    SKIP_PATTERN.lastIndex = 0;
    if (!SKIP_PATTERN.test(line)) continue;
    const context = contextFor(lines, lineIndex);
    findings.push({
      file: path.relative(rootDir, filePath),
      line: lineIndex + 1,
      marker: line.trim(),
      category: classifySkip(line, context),
    });
  }
  return findings;
}

function buildReport() {
  const findings = [];
  for (const filePath of walk(rootDir)) {
    if (statSync(filePath).size === 0) continue;
    findings.push(...inventoryFile(filePath));
  }
  findings.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
  );

  const categories = {};
  const files = new Set();
  for (const finding of findings) {
    files.add(finding.file);
    categories[finding.category] = (categories[finding.category] ?? 0) + 1;
  }

  return {
    root: "packages/feed",
    summary: {
      skipMarkers: findings.length,
      files: files.size,
      categories,
    },
    findings,
  };
}

function printText(report) {
  console.log("# Feed skip inventory");
  console.log(`skip markers: ${report.summary.skipMarkers}`);
  console.log(`files: ${report.summary.files}`);
  console.log("");
  console.log("categories:");
  for (const [category, count] of Object.entries(report.summary.categories)) {
    console.log(`- ${category}: ${count}`);
  }
  console.log("");
  console.log("findings:");
  for (const finding of report.findings) {
    console.log(
      `- ${finding.category} ${finding.file}:${finding.line} ${finding.marker}`,
    );
  }
}

const args = parseArgs(process.argv.slice(2));
const report = buildReport();

if (args.format === "json") {
  console.log(JSON.stringify(report, null, 2));
} else {
  printText(report);
}

if (
  args.failOnUndocumentedUnconditional &&
  (report.summary.categories["undocumented-unconditional"] ?? 0) > 0
) {
  process.exitCode = 1;
}
