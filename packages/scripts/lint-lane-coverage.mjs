/**
 * lint-lane-coverage.mjs
 *
 * For each plugin under plugins/:
 *  1. Asserts at least one *.test.ts or *.e2e.test.ts exists (warn if missing).
 *  2. For each *.real.e2e.test.ts, parses a top-of-file comment like:
 *       // requires: DISCORD_BOT_TOKEN, DISCORD_TEST_GUILD_ID
 *     and asserts each named env var appears in .env.test.example.
 *
 * Exit 0 always (warn-only mode); will switch to exit 1 after Phase 4.
 *
 * Output: per-plugin status table.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const PLUGINS_DIR = path.join(repoRoot, "plugins");
const ENV_TEST_EXAMPLE = path.join(repoRoot, ".env.test.example");

const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", ".git", "target"]);

// ---------------------------------------------------------------------------
// Load .env.test.example key names
// ---------------------------------------------------------------------------

function loadEnvTestExampleKeys() {
  if (!fs.existsSync(ENV_TEST_EXAMPLE)) {
    return new Set();
  }
  const content = fs.readFileSync(ENV_TEST_EXAMPLE, "utf8");
  const keys = new Set();
  for (const line of content.split("\n")) {
    // Match lines like KEY=... or export KEY=... (ignoring comments)
    const trimmed = line.replace(/#.*$/, "").trim();
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match) {
      keys.add(match[1]);
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Parse `// requires: FOO, BAR` from first 20 lines of a file
// ---------------------------------------------------------------------------

function parseRequiresComment(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n").slice(0, 20);
  for (const line of lines) {
    const match = line.match(/\/\/\s*requires?:\s*(.+)/i);
    if (match) {
      return match[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Walk a directory for test files
// ---------------------------------------------------------------------------

function collectTestFiles(dir) {
  const unitTests = [];
  const e2eTests = [];
  const realE2eTests = [];

  function walk(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const name = entry.name;
        if (/\.real\.e2e\.test\.[cm]?[tj]sx?$/.test(name)) {
          realE2eTests.push(fullPath);
        } else if (/\.e2e\.test\.[cm]?[tj]sx?$/.test(name)) {
          e2eTests.push(fullPath);
        } else if (/\.test\.[cm]?[tj]sx?$/.test(name)) {
          unitTests.push(fullPath);
        }
      }
    }
  }

  walk(dir);
  return { unitTests, e2eTests, realE2eTests };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const envTestKeys = loadEnvTestExampleKeys();
const pluginsDir = PLUGINS_DIR;

if (!fs.existsSync(pluginsDir)) {
  console.log("[lint-lane-coverage] plugins/ directory not found. Skipping.");
  process.exit(0);
}

const plugins = fs
  .readdirSync(pluginsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

let totalPlugins = 0;
let pluginsWithNoTests = 0;
let envVarViolations = 0;

const rows = [];

for (const pluginName of plugins) {
  const pluginDir = path.join(pluginsDir, pluginName);
  totalPlugins++;

  const { unitTests, e2eTests, realE2eTests } = collectTestFiles(pluginDir);

  const hasAnyBaseTest = unitTests.length > 0 || e2eTests.length > 0;
  const status = hasAnyBaseTest ? "OK " : "WARN";
  if (!hasAnyBaseTest) pluginsWithNoTests++;

  const envVarIssues = [];
  for (const realFile of realE2eTests) {
    const required = parseRequiresComment(realFile);
    const relFile = path.relative(repoRoot, realFile);
    for (const key of required) {
      if (!envTestKeys.has(key)) {
        envVarIssues.push(
          `${relFile} requires ${key} (not in .env.test.example)`,
        );
        envVarViolations++;
      }
    }
  }

  rows.push({
    pluginName,
    status,
    unitTests: unitTests.length,
    e2eTests: e2eTests.length,
    realE2eTests: realE2eTests.length,
    envVarIssues,
  });
}

// Print table
const COL_NAME = 40;
const COL_STATUS = 6;
const COL_NUM = 6;

const header = [
  "Plugin".padEnd(COL_NAME),
  "Status".padEnd(COL_STATUS),
  "Unit".padStart(COL_NUM),
  "E2E".padStart(COL_NUM),
  "Real".padStart(COL_NUM),
].join("  ");

console.log("\n[lint-lane-coverage] Plugin test coverage:");
console.log(header);
console.log("-".repeat(header.length));

for (const row of rows) {
  const line = [
    row.pluginName.slice(0, COL_NAME).padEnd(COL_NAME),
    row.status.padEnd(COL_STATUS),
    String(row.unitTests).padStart(COL_NUM),
    String(row.e2eTests).padStart(COL_NUM),
    String(row.realE2eTests).padStart(COL_NUM),
  ].join("  ");
  console.log(line);

  for (const issue of row.envVarIssues) {
    console.warn(`  WARN env: ${issue}`);
  }
}

console.log();
console.log(
  `[lint-lane-coverage] ${totalPlugins} plugins scanned.` +
    ` ${pluginsWithNoTests} without base test coverage (warn-only).` +
    ` ${envVarViolations} env-var documentation gap(s).`,
);
console.log(
  "[lint-lane-coverage] (warn-only mode — will become exit 1 in Phase 4)",
);

// Warn-only: always exit 0
process.exit(0);
