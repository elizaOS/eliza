#!/usr/bin/env node
/**
 * Inventory + reachability classifier for build/dev/support scripts (issue
 * #10194; packages/app surface added for #10200).
 *
 * Classifies every `packages/scripts/*.mjs` file, every root `package.json`
 * script, and every `packages/app/package.json` script (the second dense script
 * surface) as one of:
 *   - reachable-from-verify
 *   - reachable-from-test
 *   - reachable-from-build
 *   - reachable-from-ci-workflow
 *   - reachable-from-operator-script
 *   - reachable-from-package-script
 *   - reachable-from-docs
 *   - reachable-from-app-internal   (packages/app scripts only)
 *   - orphan
 *
 * packages/app reachability also models Turbo task fan-out (`run-turbo run
 * build|lint|typecheck` reaches app's same-named script), `--cwd packages/app
 * <name>` invocations, `working-directory: packages/app` CI step blocks, app→app
 * `bun run <name>`, and npm pre/post lifecycle pairs.
 *
 * Reachability model:
 *   1. Root scripts form a call graph: a script body that runs `bun run X` /
 *      `npm run X` makes root script X reachable transitively.
 *   2. The seed entrypoints are `verify` (+ its `check` alias), `test`, `build`,
 *      every root script name referenced from a `.github/` workflow, and every
 *      named root script as a lower-priority human/operator entrypoint.
 *   3. A reachable script body that runs `node packages/scripts/X.mjs` (or
 *      otherwise names a packages/scripts file) makes that file reachable.
 *   4. `.github/` workflows that directly name a packages/scripts file make it
 *      reachable-from-ci-workflow.
 *   5. A reachable `.mjs` file that spawnSync/exec/imports/names another
 *      packages/scripts `.mjs` propagates reachability to it.
 *   6. A packages/scripts file named from docs/source/test text is documented
 *      as an intentional standalone/support entrypoint, not a true orphan.
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
const APP_PKG = path.join(ROOT, "packages", "app", "package.json");

const CATEGORIES = [
  "reachable-from-verify",
  "reachable-from-test",
  "reachable-from-build",
  "reachable-from-ci-workflow",
  "reachable-from-operator-script",
  "reachable-from-package-script",
  "reachable-from-docs",
  "orphan",
];

// packages/app scripts can also be reached app-internally (one app script runs
// another, or via an npm pre/post lifecycle pair) — a color the root/file graphs
// don't need. Priority: verify > test > build > ci-workflow > app-internal.
const APP_CATEGORIES = [
  "reachable-from-verify",
  "reachable-from-test",
  "reachable-from-build",
  "reachable-from-ci-workflow",
  "reachable-from-app-internal",
  "orphan",
];

const PACKAGE_JSON_PRUNE_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  "aesthetic-audit-output",
  "benchmark_results",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "reports",
]);

const DOCUMENTATION_REFERENCE_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".json",
  ".md",
  ".mdx",
  ".mjs",
  ".py",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

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

function walkPruned(dir, visit) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!PACKAGE_JSON_PRUNE_DIRS.has(entry.name)) walkPruned(full, visit);
    } else {
      visit(full);
    }
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
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^A-Za-z0-9_.-])${escaped}($|[^A-Za-z0-9_.-])`);
    if (re.test(body)) found.add(file);
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

/** Root `package.json` script callers for packages/scripts/*.mjs files. */
function filesFromOperatorScripts(reachedRoots, rootScripts, fileUniverse) {
  const callersByFile = new Map();
  for (const name of reachedRoots) {
    for (const scriptFile of referencedScriptFiles(
      rootScripts[name] ?? "",
      fileUniverse,
    )) {
      if (!callersByFile.has(scriptFile)) callersByFile.set(scriptFile, []);
      callersByFile.get(scriptFile).push({
        packageJson: "package.json",
        script: name,
      });
    }
  }

  for (const callers of callersByFile.values()) {
    callers.sort((a, b) =>
      `${a.packageJson}:${a.script}`.localeCompare(
        `${b.packageJson}:${b.script}`,
      ),
    );
  }
  return callersByFile;
}

/**
 * packages/scripts files invoked from package-local `package.json` scripts.
 *
 * Root reachability intentionally remains its own color; this catches the other
 * public package script surface so helpers used by a package command are not
 * reported as disposable just because root verify/build/CI do not call them.
 */
function filesFromPackageScripts(fileUniverse) {
  const callersByFile = new Map();
  walkPruned(ROOT, (file) => {
    if (path.basename(file) !== "package.json") return;
    if (path.resolve(file) === path.join(ROOT, "package.json")) return;

    const pkg = readJson(file);
    const scripts = pkg.scripts ?? {};
    for (const [name, body] of Object.entries(scripts)) {
      for (const scriptFile of referencedScriptFiles(body, fileUniverse)) {
        if (!callersByFile.has(scriptFile)) callersByFile.set(scriptFile, []);
        callersByFile.get(scriptFile).push({
          packageJson: path.relative(ROOT, file),
          script: name,
        });
      }
    }
  });

  for (const callers of callersByFile.values()) {
    callers.sort((a, b) =>
      `${a.packageJson}:${a.script}`.localeCompare(
        `${b.packageJson}:${b.script}`,
      ),
    );
  }
  return callersByFile;
}

/**
 * packages/scripts files referenced from docs/source/test text outside their own
 * script file. This is intentionally low priority: package.json / CI /
 * operator-script reachability wins, but a documented standalone support script
 * is not a true zero-reference orphan.
 */
function filesFromDocumentation(fileUniverse) {
  const referencesByFile = new Map();
  walkPruned(ROOT, (file) => {
    const rel = path.relative(ROOT, file);
    if (rel === "package.json" || path.basename(file) === "package.json") {
      return;
    }
    if (!DOCUMENTATION_REFERENCE_EXTENSIONS.has(path.extname(file))) return;
    const body = readTextIfReadable(file);
    if (!body) return;
    for (const scriptFile of referencedScriptFiles(body, fileUniverse)) {
      const ownScriptPath = path.join("packages", "scripts", scriptFile);
      if (rel === ownScriptPath) continue;
      if (!referencesByFile.has(scriptFile))
        referencesByFile.set(scriptFile, []);
      referencesByFile.get(scriptFile).push(rel);
    }
  });

  for (const references of referencesByFile.values()) {
    references.sort((a, b) => a.localeCompare(b));
  }
  return referencesByFile;
}

/**
 * Turbo task names a body fans out across the workspace via
 * `run-turbo.mjs run <task…>` / `turbo run <task…>`. Turbo runs each task on
 * every workspace package, so a fan-out task reaches packages/app's same-named
 * script — unless the invocation carries a positive `--filter=@elizaos/<pkg>`
 * allowlist that omits app (e.g. `build:core`). Negative `--filter=!…` filters
 * still include app, and Turbo's dependency selectors `<pkg>...` (with-deps) /
 * `...<pkg>` (with-dependents) both include the named package, so the leading/
 * trailing `...` is stripped before the equality check.
 */
function turboFanoutTasks(body) {
  const positiveElizaFilters = [
    ...body.matchAll(
      /--filter=['"]?(?:\.\.\.)?(@elizaos\/[a-z0-9-]+)(?:\.\.\.)?/g,
    ),
  ].map((m) => m[1]);
  if (
    positiveElizaFilters.length &&
    !positiveElizaFilters.some((f) => f === "@elizaos/app")
  ) {
    return new Set(); // restricted to a package set that excludes app
  }
  const tasks = new Set();
  const re = /(?:run-turbo\.mjs|\bturbo)\s+run\s+([a-z0-9:_\- ]+)/g;
  for (const match of body.matchAll(re)) {
    for (const token of match[1].split(/\s+/)) {
      if (/^[a-z0-9][a-z0-9:_-]*$/.test(token)) tasks.add(token);
      else break; // first flag/operator ends the task list
    }
  }
  return tasks;
}

/** App-script names a body invokes via `--cwd packages/app <name>`. */
function appScriptsViaCwd(body, appUniverse) {
  const found = new Set();
  const re = /--cwd\s+packages\/app\s+([a-z0-9][a-z0-9:_-]*)/gi;
  for (const match of body.matchAll(re)) {
    if (appUniverse.has(match[1])) found.add(match[1]);
  }
  return found;
}

/** App-script names a body invokes via a bare `bun|npm|pnpm|yarn run <name>`. */
function appScriptsViaRun(body, appUniverse) {
  const found = new Set();
  for (const name of referencedRootScripts(body)) {
    if (appUniverse.has(name)) found.add(name);
  }
  return found;
}

/**
 * App scripts referenced inside a `.github/` step whose `working-directory` is
 * packages/app — there the `run:` body invokes app scripts without `--cwd`.
 * Split each workflow into step blocks (list items under `steps:`) so a
 * working-directory in one step never bleeds onto another step's commands.
 */
function appScriptsFromCiWorkdir(workflowChunks, appUniverse) {
  const found = new Set();
  for (const text of workflowChunks) {
    for (const block of text.split(/\n(?=\s*- )/)) {
      if (!/working-directory:\s*packages\/app(\s|$)/m.test(block)) continue;
      for (const name of referencedRootScripts(block)) {
        if (appUniverse.has(name)) found.add(name);
      }
    }
  }
  return found;
}

/** npm lifecycle pairs present in the app scripts: `pre<x>`/`post<x>` → `<x>`. */
function lifecycleEdges(appUniverse) {
  const edges = new Map();
  for (const name of appUniverse) {
    const base = name.replace(/^(pre|post)/, "");
    if (base !== name && appUniverse.has(base)) edges.set(name, base);
  }
  return edges;
}

/** BFS app scripts: seeds + app→app `run` edges + lifecycle pre/post pairs. */
function reachableAppScripts(seeds, appScripts, appUniverse) {
  const lifecycle = lifecycleEdges(appUniverse);
  // base -> [pre/post wrappers] so reaching a base reaches its lifecycle hooks.
  const reverseLifecycle = new Map();
  for (const [hook, base] of lifecycle) {
    if (!reverseLifecycle.has(base)) reverseLifecycle.set(base, []);
    reverseLifecycle.get(base).push(hook);
  }
  const reached = new Set();
  const queue = [...seeds];
  while (queue.length) {
    const name = queue.shift();
    if (reached.has(name) || !appUniverse.has(name)) continue;
    reached.add(name);
    for (const next of appScriptsViaRun(appScripts[name] ?? "", appUniverse)) {
      if (!reached.has(next)) queue.push(next);
    }
    for (const hook of reverseLifecycle.get(name) ?? []) {
      if (!reached.has(hook)) queue.push(hook);
    }
  }
  return reached;
}

function buildInventory() {
  const rootScripts = readJson(path.join(ROOT, "package.json")).scripts ?? {};
  const fileUniverse = collectScriptFiles();
  const fileGraph = buildFileGraph(fileUniverse);
  const packageScriptCallersByFile = filesFromPackageScripts(fileUniverse);
  const documentationReferencesByFile = filesFromDocumentation(fileUniverse);

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
  const operatorRoots = reachableRootScripts(
    Object.keys(rootScripts),
    rootScripts,
  );
  const operatorScriptCallersByFile = filesFromOperatorScripts(
    operatorRoots,
    rootScripts,
    fileUniverse,
  );

  // Reachable file sets, colored by entrypoint
  // (priority verify > test > build > ci > operator > package-local script).
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
  const operatorFiles = reachableFiles(
    new Set(operatorScriptCallersByFile.keys()),
    fileGraph,
  );
  const packageScriptFiles = reachableFiles(
    new Set(packageScriptCallersByFile.keys()),
    fileGraph,
  );
  const documentedFiles = reachableFiles(
    new Set(documentationReferencesByFile.keys()),
    fileGraph,
  );

  const classifyRoot = (name) => {
    if (verifyRoots.has(name)) return "reachable-from-verify";
    if (testRoots.has(name)) return "reachable-from-test";
    if (buildRoots.has(name)) return "reachable-from-build";
    if (ciRoots.has(name)) return "reachable-from-ci-workflow";
    if (operatorRoots.has(name)) return "reachable-from-operator-script";
    return "orphan";
  };
  const classifyFile = (file) => {
    if (verifyFiles.has(file)) return "reachable-from-verify";
    if (testFiles.has(file)) return "reachable-from-test";
    if (buildFiles.has(file)) return "reachable-from-build";
    if (ciFiles.has(file)) return "reachable-from-ci-workflow";
    if (operatorFiles.has(file)) return "reachable-from-operator-script";
    if (packageScriptFiles.has(file)) return "reachable-from-package-script";
    if (documentedFiles.has(file)) return "reachable-from-docs";
    return "orphan";
  };

  const files = fileUniverse.map((file) => ({
    file,
    loc: loc(path.join(SCRIPTS_DIR, file)),
    category: classifyFile(file),
    operatorScriptCallers: operatorScriptCallersByFile.get(file) ?? [],
    packageScriptCallers: packageScriptCallersByFile.get(file) ?? [],
    documentationReferences: documentationReferencesByFile.get(file) ?? [],
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

  // packages/app — the second dense script surface (issue #10200, item 2). An app
  // script is reachable when a reachable root script or a CI workflow invokes it
  // (via `--cwd packages/app <name>` or a `working-directory: packages/app` step),
  // or when another reachable app script / npm lifecycle hook chains to it.
  const appScripts = existsSync(APP_PKG)
    ? (readJson(APP_PKG).scripts ?? {})
    : {};
  const appUniverse = new Set(Object.keys(appScripts));

  const appSeedsByColor = {
    "reachable-from-verify": new Set(),
    "reachable-from-test": new Set(),
    "reachable-from-build": new Set(),
    "reachable-from-ci-workflow": new Set(),
  };
  for (const name of Object.keys(rootScripts)) {
    const color = classifyRoot(name);
    if (!(color in appSeedsByColor)) continue;
    for (const app of appScriptsViaCwd(rootScripts[name], appUniverse)) {
      appSeedsByColor[color].add(app);
    }
    // Turbo fan-out: `run-turbo run build|lint|typecheck|…` reaches app's
    // same-named script across the whole workspace.
    for (const task of turboFanoutTasks(rootScripts[name])) {
      if (appUniverse.has(task)) appSeedsByColor[color].add(task);
    }
  }
  for (const app of appScriptsViaCwd(ciText, appUniverse)) {
    appSeedsByColor["reachable-from-ci-workflow"].add(app);
  }
  for (const app of appScriptsFromCiWorkdir(workflowChunks, appUniverse)) {
    appSeedsByColor["reachable-from-ci-workflow"].add(app);
  }

  const verifyApp = reachableAppScripts(
    appSeedsByColor["reachable-from-verify"],
    appScripts,
    appUniverse,
  );
  const testApp = reachableAppScripts(
    appSeedsByColor["reachable-from-test"],
    appScripts,
    appUniverse,
  );
  const buildApp = reachableAppScripts(
    appSeedsByColor["reachable-from-build"],
    appScripts,
    appUniverse,
  );
  const ciApp = reachableAppScripts(
    appSeedsByColor["reachable-from-ci-workflow"],
    appScripts,
    appUniverse,
  );
  // App-internal: reachable through the app graph from any directly-seeded script.
  const directlySeeded = new Set([
    ...verifyApp,
    ...testApp,
    ...buildApp,
    ...ciApp,
  ]);
  const internalApp = reachableAppScripts(
    directlySeeded,
    appScripts,
    appUniverse,
  );

  const classifyApp = (name) => {
    if (verifyApp.has(name)) return "reachable-from-verify";
    if (testApp.has(name)) return "reachable-from-test";
    if (buildApp.has(name)) return "reachable-from-build";
    if (ciApp.has(name)) return "reachable-from-ci-workflow";
    if (internalApp.has(name)) return "reachable-from-app-internal";
    return "orphan";
  };
  const appScriptList = Object.keys(appScripts).map((name) => ({
    name,
    category: classifyApp(name),
  }));
  const appTotals = Object.fromEntries(APP_CATEGORIES.map((c) => [c, 0]));
  for (const a of appScriptList) appTotals[a.category] += 1;

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
      packageScriptFileReferences: [
        ...packageScriptCallersByFile.values(),
      ].reduce((sum, callers) => sum + callers.length, 0),
      operatorScriptFileReferences: [
        ...operatorScriptCallersByFile.values(),
      ].reduce((sum, callers) => sum + callers.length, 0),
      documentationFileReferences: [
        ...documentationReferencesByFile.values(),
      ].reduce((sum, references) => sum + references.length, 0),
      totalAppScripts: appScriptList.length,
      orphanAppScripts: appTotals.orphan,
      appScriptsByCategory: appTotals,
    },
    files,
    roots,
    appScripts: appScriptList,
  };
}

function printSummary(inv) {
  const { summary } = inv;
  const w = process.stdout.write.bind(process.stdout);
  const categoryWidth = 31;
  w("\n[audit-scripts-inventory] packages/scripts/*.mjs reachability\n\n");
  w(`  ${"category".padEnd(categoryWidth)} files     loc   roots\n`);
  w(`  ${"-".repeat(categoryWidth)} ------- ------- -------\n`);
  for (const c of CATEGORIES) {
    w(
      `  ${c.padEnd(categoryWidth)} ${String(summary.filesByCategory[c]).padStart(5)} ` +
        `${String(summary.locByCategory[c]).padStart(7)} ` +
        `${String(summary.rootScriptsByCategory[c]).padStart(7)}\n`,
    );
  }
  w(`  ${"-".repeat(categoryWidth)} ------- ------- -------\n`);
  w(
    `  ${"TOTAL".padEnd(categoryWidth)} ${String(summary.totalFiles).padStart(5)} ` +
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
    w(
      "\n  note: orphan here means no root/CI/package-script caller found, " +
        'not "safe to delete". Root operator commands are tracked separately.\n\n',
    );
  }

  // packages/app — the second dense script surface (issue #10200, item 2).
  w("[audit-scripts-inventory] packages/app/package.json reachability\n\n");
  w("  category                       scripts\n");
  w("  ---------------------------- ---------\n");
  for (const c of APP_CATEGORIES) {
    w(
      `  ${c.padEnd(28)} ${String(summary.appScriptsByCategory[c]).padStart(7)}\n`,
    );
  }
  w("  ---------------------------- ---------\n");
  w(
    `  ${"TOTAL".padEnd(28)} ${String(summary.totalAppScripts).padStart(7)}\n\n`,
  );
  w(
    `  app scripts: ${summary.totalAppScripts} (${summary.orphanAppScripts} ` +
      `with no detected automated caller)\n` +
      '  note: orphan here means "no root/CI/app-internal caller found", not ' +
      '"safe to delete" — many are\n  human/maintainer entrypoints ' +
      "(build:ios:*, capture:*, preflight:*), the same as root DEV-ENTRY scripts.\n\n",
  );
  const appOrphans = inv.appScripts.filter((a) => a.category === "orphan");
  if (appOrphans.length) {
    w("  app scripts with no detected automated caller:\n");
    for (const a of appOrphans) w(`    - ${a.name}\n`);
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
