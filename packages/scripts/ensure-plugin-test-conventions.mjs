#!/usr/bin/env node
/**
 * ensure-plugin-test-conventions.mjs
 *
 * Applies consistent test script conventions across all plugins so that
 * `bun run test` at the repo level doesn't fail due to:
 * - Vitest exiting 1 when no test files are found
 * - Rust tests failing (e.g. API mismatch, missing toolchain)
 * - Python tests failing when pytest is not installed
 *
 * Conventions applied:
 * 1. Vitest: --passWithNoTests is NOT added (every plugin must have tests).
 * 2. Rust: test:rs / test:rust runs are wrapped so failure doesn't fail the
 *    task: (cd rust && cargo test) || echo 'Rust tests skipped'
 * 3. Python: test:py / test:python runs guard on pytest when possible so
 *    missing pytest doesn't fail: command -v pytest >/dev/null 2>&1 && ...
 * 4. Top-level plugin workspaces must expose real test/typecheck/lint/format
 *    scripts so Turbo does not treat them as transit-only graph nodes.
 * 5. Orphaned test files: every on-disk plugin `*.test.*`/`*.spec.*` file
 *    (including `.mjs`/`.js` vitest suites) must be reachable by some
 *    vitest*.config.* include glob under the same plugin, or by Vitest's
 *    built-in default include when that plugin has no auto-discovered
 *    config, or be a documented, dated exception. `bun:test` / `node:test`
 *    files are out of scope.
 *
 * Usage:
 *   bun run ensure-plugin-test-conventions     # apply to all plugins
 *   bun run ensure-plugin-test-conventions --dry-run   # print what would change
 *   bun run ensure-plugin-test-conventions --check     # exit 1 if any would change (CI)
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

// tinyglobby is vitest's own glob engine; resolve it through vitest's module
// chain so this check uses byte-for-byte the matcher vitest runs with, and so
// resolution works under bun's nested vendoring where tinyglobby is not
// hoisted to the workspace root.
const requireFromVitest = createRequire(
  createRequire(import.meta.url).resolve("vitest/package.json"),
);
const { glob } = requireFromVitest("tinyglobby");

import { configDefaults } from "vitest/config";

const ROOT = resolve(import.meta.dirname, "../..");
const DRY_RUN = process.argv.includes("--dry-run");
const CHECK = process.argv.includes("--check");

const RUST_SKIP_MSG = "Rust tests skipped";
const PYTHON_SKIP_MSG = "Python tests skipped";
const REQUIRED_WORKSPACE_SCRIPTS = [
  "test",
  "typecheck",
  "lint",
  "lint:check",
  "format",
  "format:check",
];

function findPackageJsonFiles(dir, list = []) {
  if (!existsSync(dir)) return list;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    const relPath = p.replace(ROOT + "/", "");
    if (e.name === "node_modules" || e.name === "dist" || e.name === ".git")
      continue;
    if (e.name === "data" || e.name === "stagehand-server") continue;
    if (e.isDirectory()) {
      findPackageJsonFiles(p, list);
    } else if (e.name === "package.json") {
      if (relPath.startsWith("plugins/")) list.push(join(dir, e.name));
    }
  }
  return list;
}

function findPluginWorkspacePackageJsonFiles() {
  const pluginsDir = join(ROOT, "plugins");
  if (!existsSync(pluginsDir)) return [];
  const entries = readdirSync(pluginsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(pluginsDir, entry.name, "package.json"))
    .filter((filePath) => existsSync(filePath))
    .sort();
}

function rel(filePath) {
  return filePath.replace(ROOT + "/", "");
}

function hasFakeSuccess(value) {
  if (typeof value !== "string") return false;
  return /^\s*echo\b/.test(value) || /\|\|\s*true\b/.test(value);
}

function delegatesToNestedScript(value, scriptName) {
  return value === `cd src && bun run ${scriptName}`;
}

function hasBiomeCommand(value, commandName) {
  return (
    typeof value === "string" &&
    value.includes("@biomejs/biome") &&
    value.includes(commandName)
  );
}

function isMutatingLint(value) {
  return (
    delegatesToNestedScript(value, "lint") ||
    (hasBiomeCommand(value, "check") && value.includes("--write"))
  );
}

function isReadOnlyLintCheck(value) {
  return (
    delegatesToNestedScript(value, "lint:check") ||
    ((hasBiomeCommand(value, "check") || hasBiomeCommand(value, "lint")) &&
      !value.includes("--write"))
  );
}

function isMutatingFormat(value) {
  return (
    delegatesToNestedScript(value, "format") ||
    (hasBiomeCommand(value, "format") && value.includes("--write"))
  );
}

function isReadOnlyFormatCheck(value) {
  return (
    delegatesToNestedScript(value, "format:check") ||
    (hasBiomeCommand(value, "format") && !value.includes("--write"))
  );
}

function validateWorkspaceScriptContract(filePath) {
  const pkg = JSON.parse(readFileSync(filePath, "utf8"));
  const scripts = pkg.scripts;
  const errors = [];

  if (!scripts || typeof scripts !== "object") {
    return [`${rel(filePath)} has no scripts object`];
  }

  for (const scriptName of REQUIRED_WORKSPACE_SCRIPTS) {
    const value = scripts[scriptName];
    if (!value) {
      errors.push(`${rel(filePath)} missing required script "${scriptName}"`);
      continue;
    }
    if (hasFakeSuccess(value)) {
      errors.push(
        `${rel(filePath)} script "${scriptName}" is a fake success command: ${value}`,
      );
    }
  }

  if (scripts.lint && !isMutatingLint(scripts.lint)) {
    errors.push(`${rel(filePath)} lint must run a mutating Biome check`);
  }
  if (scripts["lint:check"] && !isReadOnlyLintCheck(scripts["lint:check"])) {
    errors.push(`${rel(filePath)} lint:check must be read-only`);
  }
  if (scripts.format && !isMutatingFormat(scripts.format)) {
    errors.push(`${rel(filePath)} format must run a mutating Biome format`);
  }
  if (
    scripts["format:check"] &&
    !isReadOnlyFormatCheck(scripts["format:check"])
  ) {
    errors.push(`${rel(filePath)} format:check must be read-only`);
  }

  return errors;
}

function validateAllWorkspaceScriptContracts() {
  const errors = [];
  for (const filePath of findPluginWorkspacePackageJsonFiles()) {
    errors.push(...validateWorkspaceScriptContract(filePath));
  }
  return errors;
}

function ensureVitestNoPassWithNoTests(value) {
  if (typeof value !== "string") return value;
  if (!value.includes("--passWithNoTests")) return value;
  return value.replace(/ --passWithNoTests/g, "");
}

function ensureRustResilient(value) {
  if (typeof value !== "string") return value;
  if (value.includes("|| echo") && value.includes("Rust")) return value;
  if (value.includes("|| echo") && value.includes("skipped")) return value;
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("cd rust") || trimmed.startsWith("(cd rust")) &&
    trimmed.includes("cargo test")
  ) {
    if (trimmed.startsWith("(") && trimmed.includes(") ||")) return value;
    if (trimmed.includes(") ||")) return value;
    if (trimmed.startsWith("(test ") && trimmed.includes("Darwin"))
      return value;
    return `(${trimmed}) || echo '${RUST_SKIP_MSG}'`;
  }
  return value;
}

function ensurePythonPytestGuard(value) {
  if (typeof value !== "string") return value;
  if (value.includes("command -v pytest") || value.includes("pytest not found"))
    return value;
  if (!value.includes("pytest")) return value;
  if (value.includes("test -d python") && value.includes("|| echo"))
    return value;
  const hasDirCheck =
    value.includes("test -d python") || value.includes("test -d python;");
  if (hasDirCheck) return value;
  if (value.startsWith("cd python") && value.includes("pytest")) {
    return `test -d python && (command -v pytest >/dev/null 2>&1 && cd python && ${value.replace(/^cd python && ?/, "")}) || echo '${PYTHON_SKIP_MSG} (no dir or pytest not found)'`;
  }
  return value;
}

function processPackageJson(filePath) {
  const content = readFileSync(filePath, "utf8");
  let pkg;
  try {
    pkg = JSON.parse(content);
  } catch (e) {
    console.warn("Skip (invalid JSON):", filePath);
    return { changed: false };
  }
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== "object") return { changed: false };

  let changed = false;
  const scriptNames = Object.keys(scripts);

  for (const name of scriptNames) {
    const raw = scripts[name];
    let next = raw;

    if (raw.includes("--passWithNoTests")) {
      next = ensureVitestNoPassWithNoTests(next);
    }
    if (name === "test:rs" || name === "test:rust") {
      next = ensureRustResilient(next);
    }
    if (name === "test:py" || name === "test:python") {
      next = ensurePythonPytestGuard(next);
    }

    if (next !== raw) {
      scripts[name] = next;
      changed = true;
    }
  }

  if (changed) {
    const newContent = JSON.stringify(pkg, null, 2) + "\n";
    if (CHECK) {
      console.log("Would change:", filePath.replace(ROOT + "/", ""));
      return { changed: true };
    }
    if (!DRY_RUN) {
      writeFileSync(filePath, newContent);
    }
    console.log(
      DRY_RUN ? "Would update:" : "Updated:",
      filePath.replace(ROOT + "/", ""),
    );
  }
  return { changed };
}

// ---------------------------------------------------------------------------
// Orphaned plugin test file detector
//
// A plugin's on-disk test file only ever runs if some vitest*.config.* file
// under that plugin's tree names it in its `include` glob. A config can
// drift from the files it was written against -- a directory gets renamed, a
// new suite lands next to an existing one instead of inside it, a suffix
// convention changes -- and silently stop running a file forever. Vitest
// exits 0 either way, so nothing signals the gap. This section resolves each
// plugin's include coverage with the same glob engine vitest uses
// (tinyglobby) and fails when an on-disk test file is not a candidate under
// any of that plugin's configs.
//
// Coverage checks `include` only, not `include` minus `exclude`. Several
// plugins (see VITEST_LANE in packages/scripts/run-all-tests.mjs) list a
// live/real suite in `include` and then exclude it conditionally so the
// default lane skips it while a `post-merge` run exercises it for real;
// others (plugin-documents, plugin-form, plugin-inbox, plugin-relationships,
// plugin-vision) list live/e2e suites in `include` and exclude them
// unconditionally because a dedicated root config
// (packages/scripts/vitest/e2e.config.ts) owns running them instead -- either
// by explicit path in its specializedLiveE2EPaths, or, for plugin-vision,
// implicitly via its generic `plugins/**/*.e2e.test.{ts,tsx}` include (proven
// by `vitest list --config packages/scripts/vitest/e2e.config.ts`, not just
// pattern-reading, before trusting that unconditional exclude as intentional
// double-run prevention rather than a real gap). Both are deliberate,
// code-reviewable routing decisions, not the "nobody's glob even reaches this
// file" gap this guard exists to catch, so applying `exclude` here would
// misreport dozens of intentionally-gated suites as orphans.
//
// Two more coverage sources beyond a plugin's own configs' `include`:
//
// 1. A plugin can have zero auto-discovered default config. Plain
//    `vitest run` (a plugin's actual "test" script, e.g. plugin-browser) only
//    ever finds `vitest.config.*`/`vite.config.*` at its cwd; a differently
//    named file (`vitest.real.config.ts`, `vitest.audit.config.ts`, ...) is a
//    named lane only used via an explicit `--config` flag and is never
//    consulted for the default run. When a plugin has no auto-discovered
//    default config, the guard falls back to Vitest's own built-in
//    `configDefaults.include`, rooted at the plugin directory, matching what
//    `vitest run` actually finds there.
// 2. A file that imports its test primitives from `bun:test` is not a Vitest
//    test at all -- it registers into Bun's own runner, not Vitest's, so no
//    `include` glob was ever going to make it run under Vitest (see
//    plugin-elizacloud/vitest.config.ts's `dist-packaging.test.ts` exclude
//    comment for a documented instance of the same fact: "runs under `bun
//    test` ... can never execute under vitest"). Such files -- e.g.
//    plugin-local-inference/native's Makefile- and `bun test`-driven suites,
//    kept out of that plugin's own `include` for the same reason -- are
//    dropped from the on-disk candidate set instead of being misreported as
//    Vitest orphans.
// ---------------------------------------------------------------------------

const PLUGIN_TEST_FILE_INCLUDE = [
  "**/*.test.{ts,tsx,mts,cts,js,mjs,cjs}",
  "**/*.spec.{ts,tsx,mts,cts,js,mjs,cjs}",
];
const PLUGIN_TEST_STRUCTURAL_IGNORE = ["**/node_modules/**", "**/dist/**"];
const VITEST_CONFIG_GLOB = ["**/vitest*.config.{ts,mts,cts,js,mjs,cjs}"];
const NON_VITEST_HARNESS_IMPORT_RE = /from\s+["'](?:bun:test|node:test)["']/;

/**
 * Vitest's own auto-discovered default config filenames -- mirrors
 * `CONFIG_NAMES`/`CONFIG_EXTENSIONS` in vitest's `constants` chunk
 * (node_modules/vitest/dist/chunks/constants.*.js). A plain `vitest run` with
 * no `--config` flag only ever finds one of these exact names in its cwd.
 */
const VITEST_DEFAULT_CONFIG_FILENAMES = [
  "vitest.config",
  "vite.config",
].flatMap((name) =>
  [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"].map((ext) => name + ext),
);

/**
 * Fail-closed exceptions for on-disk plugin test files that no plugin vitest
 * config's `include` glob currently reaches. Each entry must name a file
 * that both exists and is currently orphaned; the guard throws the moment
 * either stops holding, so a stale entry can never quietly outlive the gap it
 * was recorded for. Mirrors SCRIPT_TEST_EXCLUSIONS in
 * packages/scripts/lib/script-test-inventory.mjs.
 */
export const ORPHANED_PLUGIN_TEST_EXCEPTIONS = new Map([
  // Intentionally empty: every on-disk plugin test file is reachable by its
  // plugin's own vitest config include glob. Add a [path, reason] pair here
  // only for a triaged, deliberately-deferred orphan -- never to silence an
  // untriaged finding.
]);

function findPluginDirectories() {
  const pluginsDir = join(ROOT, "plugins");
  if (!existsSync(pluginsDir)) return [];
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(pluginsDir, entry.name))
    .filter((dir) => existsSync(join(dir, "package.json")))
    .sort();
}

async function findVitestConfigPaths(pluginDir) {
  const matches = await glob(VITEST_CONFIG_GLOB, {
    cwd: pluginDir,
    dot: true,
    ignore: PLUGIN_TEST_STRUCTURAL_IGNORE,
    expandDirectories: false,
  });
  return matches.map((relPath) => join(pluginDir, relPath)).sort();
}

/**
 * True when `pluginDir` has one of Vitest's own auto-discovered default
 * config filenames directly at its root -- i.e. a plain `vitest run` there
 * finds a config without a `--config` flag. False means that plugin's
 * default test run falls back to Vitest's built-in defaults instead.
 */
export function hasAutoDiscoveredDefaultConfig(pluginDir) {
  return VITEST_DEFAULT_CONFIG_FILENAMES.some((name) =>
    existsSync(join(pluginDir, name)),
  );
}

/**
 * True when a file's own imports declare it a Bun-native or Node-native
 * test (`bun:test` / `node:test`) rather than a Vitest one -- see the
 * module header for why that makes it categorically out of scope for this
 * guard regardless of which directory it lives in.
 */
export function isBunTestFile(absPath) {
  return NON_VITEST_HARNESS_IMPORT_RE.test(readFileSync(absPath, "utf8"));
}

async function findOnDiskPluginTestFiles(pluginDir) {
  const matches = await glob(PLUGIN_TEST_FILE_INCLUDE, {
    cwd: pluginDir,
    dot: true,
    ignore: PLUGIN_TEST_STRUCTURAL_IGNORE,
    expandDirectories: false,
  });
  return matches.map((relPath) => join(pluginDir, relPath)).sort();
}

async function loadVitestConfig(configPath) {
  const mod = await import(pathToFileURL(configPath).href);
  let config = mod.default;
  if (typeof config === "function") {
    config = await config({ mode: "test", command: "serve" });
  }
  return config ?? {};
}

/**
 * Resolves the absolute set of files a single vitest config's `include` glob
 * names, ignoring only structural noise. See the module header above for why
 * the config's own `exclude` is not applied here.
 */
async function resolveConfigIncludedFiles(configPath) {
  const config = await loadVitestConfig(configPath);
  const test = config.test ?? {};
  const include = test.include ?? configDefaults.include;
  // Vitest falls back to the top-level Vite `root` when `test.root` is not
  // set (several plugin configs, e.g. plugin-personal-assistant, only set
  // the top-level `root` and write `include` patterns relative to it) --
  // checking only `test.root` here would silently glob the wrong directory
  // and misreport every file in that plugin as orphaned.
  const effectiveRoot = test.root ?? config.root;
  const cwd = effectiveRoot
    ? resolve(dirname(configPath), effectiveRoot)
    : dirname(configPath);
  const matches = await glob(include, {
    cwd,
    dot: true,
    ignore: PLUGIN_TEST_STRUCTURAL_IGNORE,
    expandDirectories: false,
  });
  return matches.map((relPath) => resolve(cwd, relPath));
}

function toRepoRelative(absPath) {
  return relative(ROOT, absPath).split(sep).join("/");
}

/**
 * Pure orphan computation: given every on-disk plugin test file, the set of
 * files some plugin config's include glob names, and the documented
 * exception map, returns the files that are truly unaccounted for. Throws on
 * a stale exception -- one naming a file that no longer exists, or that is no
 * longer orphaned -- so the exception list can never silently drift from
 * reality. Exported for the script's own unit tests.
 */
export function computeOrphanedPluginTestFiles({
  testFiles,
  coveredFiles,
  exceptions,
}) {
  const covered =
    coveredFiles instanceof Set ? coveredFiles : new Set(coveredFiles);
  const onDisk = new Set(testFiles);
  const stale = [];
  const excused = new Set();
  for (const [file, reason] of exceptions) {
    if (typeof reason !== "string" || reason.trim().length < 12) {
      throw new Error(
        `[ensure-plugin-test-conventions] orphan exception needs a durable reason (>=12 chars): ${file}`,
      );
    }
    if (!onDisk.has(file) || covered.has(file)) {
      stale.push(file);
      continue;
    }
    excused.add(file);
  }
  if (stale.length > 0) {
    throw new Error(
      `[ensure-plugin-test-conventions] stale orphan exception(s) no longer describe a real, currently-orphaned file -- remove them: ${stale.join(", ")}`,
    );
  }
  const orphans = testFiles.filter(
    (file) => !covered.has(file) && !excused.has(file),
  );
  return { orphans, excused: [...excused] };
}

async function checkOrphanedPluginTestFiles() {
  const pluginDirs = findPluginDirectories();
  const testFiles = [];
  const coveredFiles = new Set();
  const configFailures = [];
  for (const pluginDir of pluginDirs) {
    const configPaths = await findVitestConfigPaths(pluginDir);
    const filesInPlugin = await findOnDiskPluginTestFiles(pluginDir);
    for (const file of filesInPlugin) {
      if (isBunTestFile(file)) continue;
      testFiles.push(toRepoRelative(file));
    }
    for (const configPath of configPaths) {
      try {
        const included = await resolveConfigIncludedFiles(configPath);
        for (const file of included) coveredFiles.add(toRepoRelative(file));
      } catch (error) {
        configFailures.push(
          `${toRepoRelative(configPath)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (!hasAutoDiscoveredDefaultConfig(pluginDir)) {
      // No `vitest.config.*`/`vite.config.*` at the plugin root: a plain
      // `vitest run` there (the plugin's actual "test" script) finds no
      // config and falls back to Vitest's built-in default include, rooted
      // at the plugin directory -- add that as a coverage source too.
      const fallbackMatches = await glob(configDefaults.include, {
        cwd: pluginDir,
        dot: true,
        ignore: PLUGIN_TEST_STRUCTURAL_IGNORE,
        expandDirectories: false,
      });
      for (const relPath of fallbackMatches) {
        coveredFiles.add(toRepoRelative(resolve(pluginDir, relPath)));
      }
    }
  }
  if (configFailures.length > 0) {
    console.error(
      `[ensure-plugin-test-conventions] failed to resolve ${configFailures.length} vitest config(s):\n` +
        configFailures.map((line) => `  - ${line}`).join("\n"),
    );
    return false;
  }
  const { orphans } = computeOrphanedPluginTestFiles({
    testFiles: testFiles.sort(),
    coveredFiles,
    exceptions: ORPHANED_PLUGIN_TEST_EXCEPTIONS,
  });
  if (orphans.length > 0) {
    console.error(
      `[ensure-plugin-test-conventions] ${orphans.length} orphaned plugin test file(s): no vitest config under the owning plugin includes them, so they never run.\n` +
        orphans.map((file) => `  - ${file}`).join("\n") +
        "\nWiden the owning plugin's vitest.config.ts include glob so the file is discovered, or add a dated, reasoned entry to ORPHANED_PLUGIN_TEST_EXCEPTIONS in packages/scripts/ensure-plugin-test-conventions.mjs.",
    );
    return false;
  }
  return true;
}

async function main() {
  const files = findPackageJsonFiles(join(ROOT, "plugins"));
  let anyChanged = false;
  for (const f of files) {
    const { changed } = processPackageJson(f);
    if (changed) anyChanged = true;
  }
  if (CHECK && anyChanged) {
    process.exit(1);
  }
  if (DRY_RUN && anyChanged) {
    console.log("\nRun without --dry-run to apply changes.");
  }
  const validationErrors = validateAllWorkspaceScriptContracts();
  if (validationErrors.length > 0) {
    for (const error of validationErrors) {
      console.error(error);
    }
    process.exit(1);
  }
  const orphanCheckPassed = await checkOrphanedPluginTestFiles();
  if (!orphanCheckPassed) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
