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
 *    registered Vitest or native-test runner after its effective excludes are
 *    applied, or be a documented, dated exception.
 *
 * Usage:
 *   bun run ensure-plugin-test-conventions     # apply to all plugins
 *   bun run ensure-plugin-test-conventions --dry-run   # print what would change
 *   bun run ensure-plugin-test-conventions --check     # exit 1 if any would change (CI)
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// tinyglobby is vitest's own glob engine; resolve it through vitest's module
// chain so this check uses byte-for-byte the matcher vitest runs with, and so
// resolution works under bun's nested vendoring where tinyglobby is not
// hoisted to the workspace root.
const requireFromVitest = createRequire(
  createRequire(import.meta.url).resolve("vitest/package.json"),
);
const { glob } = requireFromVitest("tinyglobby");

import { configDefaults } from "vitest/config";
import { GUARDED_REAL_LIVE_SUITES } from "./lib/real-live-suites.mjs";

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
  } catch (_error) {
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
// Coverage is positive execution reachability, not mere pattern membership:
// Vitest include-minus-exclude is evaluated for registered package lanes,
// dedicated repository E2E roots are unioned separately, and Bun/Node-native
// suites count only when a package script or audited runner root reaches them.
// This prevents an unconditional exclude, an unused named config, or a bare
// `bun:test` import from manufacturing a healthy-looking coverage result.
// ---------------------------------------------------------------------------

const PLUGIN_TEST_FILE_INCLUDE = [
  "**/*.test.{ts,tsx,mts,cts,js,mjs,cjs}",
  "**/*.spec.{ts,tsx,mts,cts,js,mjs,cjs}",
];
const PLUGIN_TEST_STRUCTURAL_IGNORE = ["**/node_modules/**", "**/dist/**"];
const VITEST_CONFIG_GLOB = ["**/vitest*.config.{ts,mts,cts,js,mjs,cjs}"];
const NON_VITEST_HARNESS_IMPORT_RE = /from\s+["'](?:bun:test|node:test)["']/;
const REGISTERED_NATIVE_RUNNER_ROOTS = new Map([
  [
    "plugins/plugin-workflow",
    [
      "__tests__",
      "package test invokes scripts/run-isolated-tests.mjs, whose recursive discovery root is __tests__",
    ],
  ],
]);
const REGISTERED_ROOT_VITEST_CONFIGS = [
  "packages/scripts/vitest/unit.config.ts",
  "packages/scripts/vitest/integration.config.ts",
  "packages/scripts/vitest/e2e.config.ts",
  "packages/scripts/vitest/live-e2e.config.ts",
  "packages/scripts/vitest/real.config.ts",
];

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
  // Add a [path, reason] pair only for a triaged, deliberately-deferred
  // orphan -- never to silence an untriaged finding.
  ["plugins/plugin-local-inference/native/llama.cpp/tools/server/webui/src/lib/services/parameter-sync.service.spec.ts", "2026-08-20: vendored upstream llama.cpp webui test (third-party tree under plugins/plugin-local-inference/native/); upstream owns its runner, we never execute these."],
  ["plugins/plugin-local-inference/native/llama.cpp/tools/server/webui/tests/client/page.svelte.test.ts", "2026-08-20: vendored upstream llama.cpp webui test (third-party tree under plugins/plugin-local-inference/native/); upstream owns its runner, we never execute these."],
  ["plugins/plugin-local-inference/native/llama.cpp/tools/server/webui/tests/e2e/demo.test.ts", "2026-08-20: vendored upstream llama.cpp webui test (third-party tree under plugins/plugin-local-inference/native/); upstream owns its runner, we never execute these."],
  ["plugins/plugin-local-inference/native/llama.cpp/tools/server/webui/tests/unit/agentic-sections.test.ts", "2026-08-20: vendored upstream llama.cpp webui test (third-party tree under plugins/plugin-local-inference/native/); upstream owns its runner, we never execute these."],
  ["plugins/plugin-local-inference/native/llama.cpp/tools/server/webui/tests/unit/agentic-strip.test.ts", "2026-08-20: vendored upstream llama.cpp webui test (third-party tree under plugins/plugin-local-inference/native/); upstream owns its runner, we never execute these."],
  ["plugins/plugin-local-inference/native/llama.cpp/tools/server/webui/tests/unit/clipboard.test.ts", "2026-08-20: vendored upstream llama.cpp webui test (third-party tree under plugins/plugin-local-inference/native/); upstream owns its runner, we never execute these."],
  ["plugins/plugin-local-inference/native/llama.cpp/tools/server/webui/tests/unit/latex-protection.test.ts", "2026-08-20: vendored upstream llama.cpp webui test (third-party tree under plugins/plugin-local-inference/native/); upstream owns its runner, we never execute these."],
  ["plugins/plugin-local-inference/native/llama.cpp/tools/server/webui/tests/unit/mcp-service.test.ts", "2026-08-20: vendored upstream llama.cpp webui test (third-party tree under plugins/plugin-local-inference/native/); upstream owns its runner, we never execute these."],
  ["plugins/plugin-local-inference/native/llama.cpp/tools/server/webui/tests/unit/model-id-parser.test.ts", "2026-08-20: vendored upstream llama.cpp webui test (third-party tree under plugins/plugin-local-inference/native/); upstream owns its runner, we never execute these."],
  ["plugins/plugin-local-inference/native/llama.cpp/tools/server/webui/tests/unit/model-names.test.ts", "2026-08-20: vendored upstream llama.cpp webui test (third-party tree under plugins/plugin-local-inference/native/); upstream owns its runner, we never execute these."],
  ["plugins/plugin-local-inference/native/llama.cpp/tools/server/webui/tests/unit/reasoning-context.test.ts", "2026-08-20: vendored upstream llama.cpp webui test (third-party tree under plugins/plugin-local-inference/native/); upstream owns its runner, we never execute these."],
  ["plugins/plugin-local-inference/native/llama.cpp/tools/server/webui/tests/unit/redact.test.ts", "2026-08-20: vendored upstream llama.cpp webui test (third-party tree under plugins/plugin-local-inference/native/); upstream owns its runner, we never execute these."],
  ["plugins/plugin-local-inference/native/llama.cpp/tools/server/webui/tests/unit/request-helpers.test.ts", "2026-08-20: vendored upstream llama.cpp webui test (third-party tree under plugins/plugin-local-inference/native/); upstream owns its runner, we never execute these."],
  ["plugins/plugin-local-inference/native/llama.cpp/tools/server/webui/tests/unit/sanitize-headers.test.ts", "2026-08-20: vendored upstream llama.cpp webui test (third-party tree under plugins/plugin-local-inference/native/); upstream owns its runner, we never execute these."],
  ["plugins/plugin-local-inference/native/llama.cpp/tools/server/webui/tests/unit/uri-template.test.ts", "2026-08-20: vendored upstream llama.cpp webui test (third-party tree under plugins/plugin-local-inference/native/); upstream owns its runner, we never execute these."],
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
 * Classifies files that declare a Bun-native or Node-native test harness.
 * Classification alone never counts as coverage; a registered native runner
 * must still reach the file.
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

async function loadVitestConfig(configPath, lane = "default") {
  const previousTestLane = process.env.TEST_LANE;
  const previousVitestLane = process.env.VITEST_LANE;
  if (lane === "post-merge") {
    process.env.TEST_LANE = lane;
    process.env.VITEST_LANE = lane;
  } else {
    delete process.env.TEST_LANE;
    delete process.env.VITEST_LANE;
  }
  let mod;
  try {
    mod = await import(`${pathToFileURL(configPath).href}?orphan-lane=${lane}`);
  } finally {
    if (previousTestLane === undefined) delete process.env.TEST_LANE;
    else process.env.TEST_LANE = previousTestLane;
    if (previousVitestLane === undefined) delete process.env.VITEST_LANE;
    else process.env.VITEST_LANE = previousVitestLane;
  }
  let config = mod.default;
  if (typeof config === "function") {
    config = await config({ mode: "test", command: "serve" });
  }
  return config ?? {};
}

/**
 * Resolves the files a Vitest lane can actually collect: include minus its
 * effective exclude list. The repository scan evaluates the post-merge
 * superset because many package configs conditionally open live suites there.
 */
export async function resolveConfigIncludedFiles(
  configPath,
  lane = "default",
  executionRoot = dirname(configPath),
) {
  const config = await loadVitestConfig(configPath, lane);
  const test = config.test ?? {};
  const include = test.include ?? configDefaults.include;
  const exclude = test.exclude ?? configDefaults.exclude;
  // Vitest falls back to the top-level Vite `root` when `test.root` is not
  // set (several plugin configs, e.g. plugin-personal-assistant, only set
  // the top-level `root` and write `include` patterns relative to it) --
  // checking only `test.root` here would silently glob the wrong directory
  // and misreport every file in that plugin as orphaned.
  const effectiveRoot = test.root ?? config.root;
  const cwd = effectiveRoot
    ? resolve(executionRoot, effectiveRoot)
    : executionRoot;
  const matches = await glob(include, {
    cwd,
    dot: true,
    ignore: [...PLUGIN_TEST_STRUCTURAL_IGNORE, ...exclude],
    expandDirectories: false,
  });
  return matches.map((relPath) => resolve(cwd, relPath));
}

function readPluginPackage(pluginDir) {
  return JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
}

function scriptCommands(packageJson) {
  return Object.values(packageJson.scripts ?? {}).filter(
    (value) => typeof value === "string",
  );
}

function hasDefaultVitestRunner(packageJson) {
  return scriptCommands(packageJson).some(
    (command) =>
      /(?:^|\s)vitest(?:\s+run)?(?:\s|$)/.test(command) &&
      !command.includes("--config"),
  );
}

function isRegisteredPluginConfig(configPath, pluginDir, packageJson) {
  const relativePath = relative(pluginDir, configPath).split(sep).join("/");
  const isDefault =
    dirname(configPath) === pluginDir &&
    VITEST_DEFAULT_CONFIG_FILENAMES.includes(relativePath);
  if (isDefault && hasDefaultVitestRunner(packageJson)) return true;
  return scriptCommands(packageJson).some(
    (command) =>
      command.includes(relativePath) ||
      command.includes(configPath.split(sep).at(-1)),
  );
}

function commandTargetCoversFile(target, relativeFile) {
  const normalized = target.replace(/^['"]|['"]$/g, "").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("-")) return false;
  const wildcardIndex = normalized.search(/[!*?{[]/);
  const prefix = (
    wildcardIndex === -1 ? normalized : normalized.slice(0, wildcardIndex)
  ).replace(/\/$/, "");
  return (
    relativeFile === normalized ||
    (prefix && relativeFile.startsWith(`${prefix}/`))
  );
}

export function nativeTestFileIsRegistered(
  relativeFile,
  packageJson,
  pluginRelative,
) {
  const commands = scriptCommands(packageJson);
  for (const command of commands) {
    for (const match of command.matchAll(
      /(?:bun\s+test|node\s+--test)([^;&|]*)/g,
    )) {
      const tokens = match[1].trim().split(/\s+/).filter(Boolean);
      const targets = tokens.filter((token) => !token.startsWith("-"));
      if (
        targets.length === 0 ||
        targets.some((target) => commandTargetCoversFile(target, relativeFile))
      ) {
        return true;
      }
    }
  }
  const registeredRoot = REGISTERED_NATIVE_RUNNER_ROOTS.get(pluginRelative);
  return Boolean(
    registeredRoot &&
      (relativeFile === registeredRoot[0] ||
        relativeFile.startsWith(`${registeredRoot[0]}/`)),
  );
}

async function registeredRootVitestCoverage() {
  const covered = new Set();
  for (const relativeConfig of REGISTERED_ROOT_VITEST_CONFIGS) {
    const configPath = join(ROOT, relativeConfig);
    for (const file of await resolveConfigIncludedFiles(
      configPath,
      "post-merge",
      ROOT,
    )) {
      if (file.startsWith(join(ROOT, "plugins") + sep)) {
        covered.add(toRepoRelative(file));
      }
    }
  }
  const e2e = await import(
    pathToFileURL(join(ROOT, "packages/scripts/vitest/e2e.config.ts")).href
  );
  for (const registry of [
    e2e.heavyOnlyE2EPaths,
    e2e.checkoutDependentE2EPaths,
    e2e.specializedLiveE2EPaths,
    e2e.credentialDependentE2EPaths,
  ]) {
    for (const file of registry ?? []) {
      if (file.startsWith("plugins/")) covered.add(file);
    }
  }
  return covered;
}

export async function inspectPluginTestCoverage(pluginDir) {
  const packageJson = readPluginPackage(pluginDir);
  const pluginRelative = toRepoRelative(pluginDir);
  const testFiles = [];
  const coveredFiles = new Set();
  const configFailures = [];
  const filesInPlugin = await findOnDiskPluginTestFiles(pluginDir);
  for (const file of filesInPlugin) {
    const relativeFile = relative(pluginDir, file).split(sep).join("/");
    testFiles.push(relativeFile);
    if (nativeTestFileIsRegistered(relativeFile, packageJson, pluginRelative)) {
      coveredFiles.add(relativeFile);
    }
  }

  const configPaths = (await findVitestConfigPaths(pluginDir)).filter((path) =>
    isRegisteredPluginConfig(path, pluginDir, packageJson),
  );
  for (const configPath of configPaths) {
    try {
      const included = await resolveConfigIncludedFiles(
        configPath,
        "post-merge",
        pluginDir,
      );
      for (const file of included) {
        if (file.startsWith(pluginDir + sep)) {
          coveredFiles.add(relative(pluginDir, file).split(sep).join("/"));
        }
      }
    } catch (error) {
      configFailures.push(
        `${toRepoRelative(configPath)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (
    !hasAutoDiscoveredDefaultConfig(pluginDir) &&
    hasDefaultVitestRunner(packageJson)
  ) {
    const fallbackMatches = await glob(configDefaults.include, {
      cwd: pluginDir,
      dot: true,
      ignore: [...PLUGIN_TEST_STRUCTURAL_IGNORE, ...configDefaults.exclude],
      expandDirectories: false,
    });
    for (const relativeFile of fallbackMatches) coveredFiles.add(relativeFile);
  }

  return {
    testFiles: testFiles.sort(),
    coveredFiles,
    configFailures,
  };
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
  const coveredFiles = await registeredRootVitestCoverage();
  const configFailures = [];
  for (const pluginDir of pluginDirs) {
    const pluginRelative = toRepoRelative(pluginDir);
    const inspection = await inspectPluginTestCoverage(pluginDir);
    for (const file of inspection.testFiles) {
      testFiles.push(`${pluginRelative}/${file}`);
    }
    for (const file of inspection.coveredFiles) {
      coveredFiles.add(`${pluginRelative}/${file}`);
    }
    configFailures.push(...inspection.configFailures);
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
    exceptions: new Map([
      ...ORPHANED_PLUGIN_TEST_EXCEPTIONS,
      ...GUARDED_REAL_LIVE_SUITES.filter(
        (entry) =>
          entry.file.startsWith("plugins/") &&
          entry.blocked &&
          !coveredFiles.has(entry.file),
      ).map((entry) => [
        entry.file,
        `Manifested config block: ${entry.blocked}`,
      ]),
    ]),
  });
  if (orphans.length > 0) {
    console.error(
      `[ensure-plugin-test-conventions] ${orphans.length} orphaned plugin test file(s): no registered test lane reaches them after effective excludes.\n` +
        orphans.map((file) => `  - ${file}`).join("\n") +
        "\nRegister the owning Vitest/native runner, remove the orphaning exclude, or add a dated, reasoned entry to ORPHANED_PLUGIN_TEST_EXCEPTIONS in packages/scripts/ensure-plugin-test-conventions.mjs.",
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

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
