#!/usr/bin/env node
/**
 * Inventory + reachability classifier for build/dev/support scripts (issue #10194).
 *
 * Classifies every `packages/scripts/*.mjs` file and every root `package.json`
 * script as one of:
 *   - reachable-from-verify
 *   - reachable-from-test
 *   - reachable-from-build
 *   - reachable-from-ci-workflow
 *   - orphan
 *
 * Reachability model:
 *   1. Root scripts form a call graph: a script body that runs `bun run X` /
 *      `npm run X` makes root script X reachable transitively.
 *   2. The seed entrypoints are `verify` (+ its `check` alias), `test`, `build`,
 *      and every root script name referenced from a `.github/` workflow.
 *   3. A reachable script body that runs `node packages/scripts/X.mjs` (or
 *      otherwise names a packages/scripts file) makes that file reachable.
 *   4. `.github/` workflows that directly name a packages/scripts file make it
 *      reachable-from-ci-workflow.
 *   5. A reachable `.mjs` file that spawnSync/exec/imports/names another
 *      packages/scripts `.mjs` propagates reachability to it.
 *
 * Output:
 *   - machine-readable JSON to reports/scripts-inventory.json (gitignored).
 *   - a summary table to stdout (total files, total LOC, orphan count,
 *     root-script count).
 *
 * Usage:
 *   node packages/scripts/audit-scripts-inventory.mjs            # write + print
 *   node packages/scripts/audit-scripts-inventory.mjs --json     # print JSON
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const SCRIPTS_DIR = path.join(ROOT, "packages", "scripts");

const CATEGORIES = [
  "reachable-from-verify",
  "reachable-from-test",
  "reachable-from-build",
  "reachable-from-ci-workflow",
  "orphan",
];

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function readTextIfReadable(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function walk(dir, visit) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else visit(full);
  }
}

function loc(file) {
  const text = readTextIfReadable(file);
  if (!text) return 0;
  return text.split("\n").length;
}

/** All packages/scripts/*.mjs basenames (the file universe we classify). */
function collectScriptFiles() {
  return readdirSync(SCRIPTS_DIR)
    .filter((name) => name.endsWith(".mjs"))
    .sort();
}

/** Root-script names invoked from a script body via `bun|npm|pnpm|yarn run X`. */
function referencedRootScripts(body) {
  const names = new Set();
  const re =
    /\b(?:bun|npm|pnpm|yarn)\s+(?:--silent\s+)?run\s+([a-z0-9][a-z0-9:_-]*)/gi;
  for (const match of body.matchAll(re)) names.add(match[1]);
  return names;
}

/** packages/scripts/*.mjs basenames named anywhere in a text body. */
function referencedScriptFiles(body, fileUniverse) {
  const found = new Set();
  for (const file of fileUniverse) {
    if (body.includes(file)) found.add(file);
  }
  return found;
}

/** BFS the root-script call graph from a set of seed names. */
function reachableRootScripts(seeds, rootScripts) {
  const reached = new Set();
  const queue = [...seeds];
  while (queue.length) {
    const name = queue.shift();
    if (reached.has(name)) continue;
    if (!(name in rootScripts)) continue;
    reached.add(name);
    for (const next of referencedRootScripts(rootScripts[name])) {
      if (!reached.has(next)) queue.push(next);
    }
  }
  return reached;
}

/** File-graph adjacency: file -> set of packages/scripts files it references. */
function buildFileGraph(fileUniverse) {
  const graph = new Map();
  for (const file of fileUniverse) {
    const body = readTextIfReadable(path.join(SCRIPTS_DIR, file));
    const refs = referencedScriptFiles(body, fileUniverse);
    refs.delete(file);
    graph.set(file, refs);
  }
  return graph;
}

/** BFS the file graph from a set of seed files. */
function reachableFiles(seedFiles, graph) {
  const reached = new Set();
  const queue = [...seedFiles];
  while (queue.length) {
    const file = queue.shift();
    if (reached.has(file)) continue;
    reached.add(file);
    for (const next of graph.get(file) ?? []) {
      if (!reached.has(next)) queue.push(next);
    }
  }
  return reached;
}

/** Seed files named directly in reachable root-script bodies. */
function filesFromRootScripts(reachedRoots, rootScripts, fileUniverse) {
  const seeds = new Set();
  for (const name of reachedRoots) {
    for (const file of referencedScriptFiles(
      rootScripts[name] ?? "",
      fileUniverse,
    )) {
      seeds.add(file);
    }
  }
  return seeds;
}

function buildInventory() {
  const rootScripts = readJson(path.join(ROOT, "package.json")).scripts ?? {};
  const fileUniverse = collectScriptFiles();
  const fileGraph = buildFileGraph(fileUniverse);

  // CI workflow corpus + the root-script names + script files it references.
  const workflowChunks = [];
  walk(path.join(ROOT, ".github"), (file) => {
    if (/\.(ya?ml)$/.test(file)) workflowChunks.push(readTextIfReadable(file));
  });
  const ciText = workflowChunks.join("\n");
  const ciRootSeeds = referencedRootScripts(ciText);
  const ciFileSeeds = referencedScriptFiles(ciText, fileUniverse);

  // Reachable root-script sets per seed entrypoint.
  const verifyRoots = reachableRootScripts(["verify", "check"], rootScripts);
  const testRoots = reachableRootScripts(["test"], rootScripts);
  const buildRoots = reachableRootScripts(["build"], rootScripts);
  const ciRoots = reachableRootScripts(ciRootSeeds, rootScripts);

  // Reachable file sets, colored by entrypoint (priority verify>test>build>ci).
  const verifyFiles = reachableFiles(
    filesFromRootScripts(verifyRoots, rootScripts, fileUniverse),
    fileGraph,
  );
  const testFiles = reachableFiles(
    filesFromRootScripts(testRoots, rootScripts, fileUniverse),
    fileGraph,
  );
  const buildFiles = reachableFiles(
    filesFromRootScripts(buildRoots, rootScripts, fileUniverse),
    fileGraph,
  );
  const ciFiles = reachableFiles(
    new Set([
      ...filesFromRootScripts(ciRoots, rootScripts, fileUniverse),
      ...ciFileSeeds,
    ]),
    fileGraph,
  );

  const classifyRoot = (name) => {
    if (verifyRoots.has(name)) return "reachable-from-verify";
    if (testRoots.has(name)) return "reachable-from-test";
    if (buildRoots.has(name)) return "reachable-from-build";
    if (ciRoots.has(name)) return "reachable-from-ci-workflow";
    return "orphan";
  };
  const classifyFile = (file) => {
    if (verifyFiles.has(file)) return "reachable-from-verify";
    if (testFiles.has(file)) return "reachable-from-test";
    if (buildFiles.has(file)) return "reachable-from-build";
    if (ciFiles.has(file)) return "reachable-from-ci-workflow";
    return "orphan";
  };

  const files = fileUniverse.map((file) => ({
    file,
    loc: loc(path.join(SCRIPTS_DIR, file)),
    category: classifyFile(file),
  }));
  const roots = Object.keys(rootScripts).map((name) => ({
    name,
    category: classifyRoot(name),
  }));

  const fileTotals = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const fileLocTotals = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const f of files) {
    fileTotals[f.category] += 1;
    fileLocTotals[f.category] += f.loc;
  }
  const rootTotals = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const r of roots) rootTotals[r.category] += 1;

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalFiles: files.length,
      totalLoc: files.reduce((sum, f) => sum + f.loc, 0),
      orphanFiles: fileTotals.orphan,
      orphanLoc: fileLocTotals.orphan,
      totalRootScripts: roots.length,
      orphanRootScripts: rootTotals.orphan,
      filesByCategory: fileTotals,
      locByCategory: fileLocTotals,
      rootScriptsByCategory: rootTotals,
    },
    files,
    roots,
  };
}

function printSummary(inv) {
  const { summary } = inv;
  const w = process.stdout.write.bind(process.stdout);
  w("\n[audit-scripts-inventory] packages/scripts/*.mjs reachability\n\n");
  w("  category                       files     loc   roots\n");
  w("  ---------------------------- ------- ------- -------\n");
  for (const c of CATEGORIES) {
    w(
      `  ${c.padEnd(28)} ${String(summary.filesByCategory[c]).padStart(5)} ` +
        `${String(summary.locByCategory[c]).padStart(7)} ` +
        `${String(summary.rootScriptsByCategory[c]).padStart(7)}\n`,
    );
  }
  w("  ---------------------------- ------- ------- -------\n");
  w(
    `  ${"TOTAL".padEnd(28)} ${String(summary.totalFiles).padStart(5)} ` +
      `${String(summary.totalLoc).padStart(7)} ` +
      `${String(summary.totalRootScripts).padStart(7)}\n\n`,
  );
  w(
    `  total files: ${summary.totalFiles}  total LOC: ${summary.totalLoc}  ` +
      `orphan files: ${summary.orphanFiles} (${summary.orphanLoc} LOC)  ` +
      `root scripts: ${summary.totalRootScripts} (${summary.orphanRootScripts} orphan)\n\n`,
  );
  const orphans = inv.files.filter((f) => f.category === "orphan");
  if (orphans.length) {
    w("  orphan files:\n");
    for (const f of orphans) w(`    - ${f.file} (${f.loc} LOC)\n`);
    w("\n");
  }
}

function main() {
  const args = process.argv.slice(2);
  const inv = buildInventory();

  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(inv, null, 2)}\n`);
    return;
  }

  const outDir = path.join(ROOT, "reports");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "scripts-inventory.json");
  writeFileSync(outFile, `${JSON.stringify(inv, null, 2)}\n`);
  printSummary(inv);
  process.stdout.write(`  JSON written to ${path.relative(ROOT, outFile)}\n\n`);
}

export { buildInventory };

if (import.meta.url === `file://${process.argv[1]}`) main();
