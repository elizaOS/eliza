/**
 * run-all-tests.mjs
 *
 * Cross-package test runner for the elizaOS monorepo. Discovers every
 * workspace package via root package.json `workspaces`, then runs each
 * package's deterministic `test` script by default. Explicit modes can
 * expand the sweep to integration/e2e/playwright/manual cloud coverage.
 *
 * Lane / shard / filter knobs are honoured via a mix of CLI flags and
 * env vars so CI matrices can drive sharding deterministically:
 *
 *   TEST_LANE=pr (default)
 *     Mockoon-backed lane. Sets VITEST_EXCLUDE_REAL_E2E=1 and
 *     VITEST_EXCLUDE_REAL=1 so package vitest configs can drop
 *     *.real.e2e.test.ts and *.real.test.ts files. Warns when
 *     CEREBRAS_API_KEY is missing.
 *
 *   TEST_LANE=post-merge
 *     Real APIs everywhere. No exclusions. Warns when
 *     scripts/post-merge-secrets.txt entries are missing.
 *
 *   TEST_SHARD=N/M
 *     Deterministic shard membership. Each task's relative package dir
 *     is SHA-1 hashed; tasks where (hash % M) === (N - 1) run on this
 *     shard (1-indexed N).
 *
 *   --all
 *     Run package `test` scripts plus integration/e2e/playwright scripts.
 *
 *   --cloud
 *     Run the cloud test step at the end. `--all` implies cloud unless
 *     `--no-cloud` is also passed.
 *
 *   --no-cloud
 *     Skip the cloud test step at the end.
 *
 *   --filter=<regex>
 *     Match against `<packageName> (<relativeDir>)#<scriptName>`.
 *     Combines (intersects) with --pattern and TEST_PACKAGE_FILTER env.
 *
 *   --pattern=<regex>
 *     Same surface as --filter; both must match when both are passed.
 *
 *   --only=e2e | test
 *     Sets VITEST_E2E_ONLY=1 / VITEST_UNIT_ONLY=1 so vitest configs
 *     that consume those env vars can flip include/exclude patterns.
 *     For packages whose `test` script is a single `vitest run` we
 *     also append a path filter via VITEST_TEST_PATH_PATTERN.
 *
 * Companion env knobs (legacy, still honoured):
 *   TEST_PACKAGE_FILTER  — same surface as --filter
 *   TEST_SCRIPT_FILTER   — regex over script name (test, test:e2e, ...)
 *   TEST_START_AT        — resume a suite from the first matching label
 *
 * See `.env.test.example` and `scripts/test-env.mjs` for live env setup.
 */

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTestRuntimeEnv } from "./lib/test-runtime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const parentRepoRoot = path.dirname(repoRoot);
const outerRepoRoot =
  path.basename(repoRoot) === "eliza" &&
  fs.existsSync(path.join(parentRepoRoot, "package.json")) &&
  fs.existsSync(path.join(parentRepoRoot, "eliza", "package.json"))
    ? parentRepoRoot
    : repoRoot;
const testRuntimeEnv = buildTestRuntimeEnv(process.env, { repoRoot });
const bunCmd = testRuntimeEnv.npm_execpath || testRuntimeEnv.BUN || "bun";

// ---------------------------------------------------------------------------
// CLI flag parsing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

function parseFlag(name) {
  const idx = argv.indexOf(name);
  if (idx !== -1) {
    argv.splice(idx, 1);
    return true;
  }
  return false;
}

function parseFlagValue(prefix) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === prefix && i + 1 < argv.length) {
      const value = argv[i + 1];
      argv.splice(i, 2);
      return value;
    }
    if (arg.startsWith(`${prefix}=`)) {
      const value = arg.slice(prefix.length + 1);
      argv.splice(i, 1);
      return value;
    }
  }
  return null;
}

const allFlag = parseFlag("--all");
const cloudFlag = parseFlag("--cloud");
const explicitNoCloud = parseFlag("--no-cloud");
const helpFlag = parseFlag("--help") || parseFlag("-h");
const filterFlag = parseFlagValue("--filter");
const patternFlag = parseFlagValue("--pattern");
const onlyFlag = parseFlagValue("--only"); // "e2e" | "test"
const selectedMode = onlyFlag ?? (allFlag ? null : "test");
const noCloud = explicitNoCloud || (!cloudFlag && !allFlag);

if (onlyFlag && onlyFlag !== "e2e" && onlyFlag !== "test") {
  console.error(
    `[eliza-test] ERROR unsupported --only=${JSON.stringify(onlyFlag)}; expected "e2e" or "test".`,
  );
  process.exit(1);
}

if (allFlag && onlyFlag) {
  console.error(
    `[eliza-test] ERROR --all cannot be combined with --only=${JSON.stringify(onlyFlag)}.`,
  );
  process.exit(1);
}

if (helpFlag) {
  process.stdout.write(
    [
      "Usage: node scripts/run-all-tests.mjs [options]",
      "",
      "Options:",
      "  --all                Run package test plus integration/e2e/playwright scripts.",
      "  --cloud              Run the final cloud test step.",
      "  --no-cloud           Skip the final cloud test step.",
      "  --filter=<regex>     Filter package tasks by `<name> (<dir>)#<script>`.",
      "  --pattern=<regex>    Same surface as --filter; combined via intersection.",
      "  --only=e2e | test    Forward VITEST_E2E_ONLY / VITEST_UNIT_ONLY env to children.",
      "",
      "Env vars:",
      "  TEST_LANE=pr|post-merge        Lane select (default: pr).",
      "  TEST_SHARD=N/M                  1-indexed shard out of M total.",
      "  TEST_PACKAGE_FILTER=<regex>     Equivalent to --filter (legacy).",
      "  TEST_SCRIPT_FILTER=<regex>      Filter by script name.",
      "  TEST_START_AT=<substring>       Skip until first matching label.",
      "",
      "See `.env.test.example` for live test env setup.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Environment / lane configuration
// ---------------------------------------------------------------------------

const TEST_LANE = process.env.TEST_LANE || "pr"; // "pr" | "post-merge"
const TEST_SHARD = process.env.TEST_SHARD || ""; // "N/M"

// Parse TEST_SHARD into { index, total } or null
let shardConfig = null;
if (TEST_SHARD) {
  const parts = TEST_SHARD.split("/");
  if (parts.length === 2) {
    const index = parseInt(parts[0], 10);
    const total = parseInt(parts[1], 10);
    if (
      !Number.isNaN(index) &&
      !Number.isNaN(total) &&
      total > 0 &&
      index >= 1 &&
      index <= total
    ) {
      shardConfig = { index, total };
    } else {
      console.warn(
        `[eliza-test] WARN invalid TEST_SHARD "${TEST_SHARD}" — expected N/M (1-indexed). Ignoring.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Startup-time validation
// ---------------------------------------------------------------------------

const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const POST_MERGE_SECRETS_PATH = path.join(here, "post-merge-secrets.txt");

function loadPostMergeSecrets() {
  if (!fs.existsSync(POST_MERGE_SECRETS_PATH)) return [];
  return fs
    .readFileSync(POST_MERGE_SECRETS_PATH, "utf8")
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean);
}

if (TEST_LANE === "pr") {
  if (!process.env.CEREBRAS_API_KEY) {
    console.warn(
      `${YELLOW}[eliza-test] WARN TEST_LANE=pr but CEREBRAS_API_KEY is not set. LLM-backed tests may be skipped.${RESET}`,
    );
  }
} else if (TEST_LANE === "post-merge") {
  const secrets = loadPostMergeSecrets();
  const missing = secrets.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.warn(
      `${YELLOW}[eliza-test] WARN TEST_LANE=post-merge — missing env vars:\n  ${missing.join("\n  ")}${RESET}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Constants (from original)
// ---------------------------------------------------------------------------

const EXTRA_SCRIPT_NAMES = [
  "test:integration",
  "test:e2e:all",
  "test:e2e",
  "test:playwright",
  "test:ui",
  "test:live",
];
const E2E_COMPANION_SCRIPT_NAMES = new Set([
  "test:playwright",
  "test:ui",
  "test:live",
]);
const MANUAL_TEST_SCRIPT_PATTERN = /(?:^|:)manual(?:$|:)/;
const NO_TEST_OUTPUT_PATTERNS = [/No test files found/i, /No tests found/i];
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[tj]sx?$/;
const TEST_FILE_SKIP_DIRS = new Set([
  ".git",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);
const MAX_CAPTURED_OUTPUT_CHARS = 16_000;
const ADDITIONAL_PACKAGE_DIRS = [
  path.join(repoRoot, "packages", "app-core", "platforms", "electrobun"),
];

// Combine --filter, --pattern, and TEST_PACKAGE_FILTER. All three (when set)
// must match a task's label for it to run — they intersect rather than
// override each other so callers can stack a package filter (--filter) and a
// per-test filter (--pattern) on top of one another.
const packageFilters = [
  filterFlag,
  patternFlag,
  process.env.TEST_PACKAGE_FILTER,
]
  .filter((value) => typeof value === "string" && value.length > 0)
  .map((value) => new RegExp(value));

const scriptFilter = process.env.TEST_SCRIPT_FILTER
  ? new RegExp(process.env.TEST_SCRIPT_FILTER)
  : null;
const startAt = process.env.TEST_START_AT?.trim() || "";
const DEFAULT_POSTGRES_URL =
  "postgresql://eliza_test:test123@localhost:5432/eliza_test";
const DEFAULT_TASK_TIMEOUT_MS = 15 * 60 * 1000;
const POSTGRES_INIT_SQL_PATH = path.join(
  repoRoot,
  "plugins",
  "plugin-sql",
  "scripts",
  "init-test-db.sql",
);

// ---------------------------------------------------------------------------
// Workspace discovery (unchanged from original)
// ---------------------------------------------------------------------------

function expandWorkspacePattern(pattern) {
  const segments = pattern.split("/").filter(Boolean);
  let currentPaths = [repoRoot];

  for (const segment of segments) {
    const nextPaths = [];
    for (const currentPath of currentPaths) {
      if (segment === "*") {
        if (!fs.existsSync(currentPath)) {
          continue;
        }
        const entries = fs
          .readdirSync(currentPath, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          nextPaths.push(path.join(currentPath, entry.name));
        }
        continue;
      }
      nextPaths.push(path.join(currentPath, segment));
    }
    currentPaths = nextPaths;
  }

  return currentPaths;
}

function collectPackageJsonPaths() {
  const rootPackageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  const packageJsonPaths = new Set();

  for (const pattern of rootPackageJson.workspaces ?? []) {
    for (const packageDir of expandWorkspacePattern(pattern)) {
      const packageJsonPath = path.join(packageDir, "package.json");
      if (fs.existsSync(packageJsonPath)) {
        packageJsonPaths.add(packageJsonPath);
      }
    }
  }

  for (const packageDir of ADDITIONAL_PACKAGE_DIRS) {
    const packageJsonPath = path.join(packageDir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      packageJsonPaths.add(packageJsonPath);
    }
  }

  return [...packageJsonPaths].sort((left, right) => left.localeCompare(right));
}

// ---------------------------------------------------------------------------
// Script resolution (unchanged from original)
// ---------------------------------------------------------------------------

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function resolveScriptCommand(scriptName, scripts, seen = new Set()) {
  const raw = normalizeWhitespace(scripts?.[scriptName] ?? "");
  if (!raw) {
    return "";
  }
  if (seen.has(scriptName)) {
    return raw;
  }
  seen.add(scriptName);

  const aliasMatch = raw.match(
    /^(?:bun|npm|yarn)(?:\s+run)?\s+([A-Za-z0-9:_-]+)$/,
  );
  if (aliasMatch?.[1] && scripts?.[aliasMatch[1]]) {
    return resolveScriptCommand(aliasMatch[1], scripts, seen);
  }

  return raw;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: testRuntimeEnv,
    stdio: "pipe",
    encoding: "utf8",
    ...options,
  });

  const combinedOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return {
    ...result,
    combinedOutput,
  };
}

function resetPostgresDatabase() {
  const terminateResult = runCommand("psql", [
    "postgres",
    "-c",
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'eliza_test' AND pid <> pg_backend_pid()",
  ]);
  if (terminateResult.status !== 0) {
    throw new Error(
      terminateResult.combinedOutput ||
        "failed to terminate active PostgreSQL test connections",
    );
  }

  const dropResult = runCommand("dropdb", ["--if-exists", "eliza_test"]);
  if (dropResult.status !== 0) {
    throw new Error(
      dropResult.combinedOutput ||
        "failed to drop local PostgreSQL test database",
    );
  }

  const createResult = runCommand("createdb", ["eliza_test"]);
  if (createResult.status !== 0) {
    throw new Error(
      createResult.combinedOutput ||
        "failed to recreate local PostgreSQL test database",
    );
  }
}

function ensurePluginSqlPostgresEnv() {
  if (process.env.POSTGRES_URL?.trim()) {
    return;
  }

  if (!fs.existsSync(POSTGRES_INIT_SQL_PATH)) {
    return;
  }

  const pingResult = runCommand("psql", ["postgres", "-Atc", "SELECT 1"]);
  if (pingResult.status !== 0) {
    console.warn(
      "[eliza-test] WARN local PostgreSQL unavailable; plugin-sql Postgres-only suites will remain skipped",
    );
    return;
  }

  try {
    resetPostgresDatabase();
    const initResult = runCommand("psql", [
      "-v",
      "ON_ERROR_STOP=1",
      "-d",
      "eliza_test",
      "-f",
      POSTGRES_INIT_SQL_PATH,
    ]);
    if (initResult.status !== 0) {
      throw new Error(
        initResult.combinedOutput ||
          "failed to initialize local PostgreSQL test database",
      );
    }
    process.env.POSTGRES_URL = DEFAULT_POSTGRES_URL;
    console.log(
      `[eliza-test] INFO using PostgreSQL test database at ${DEFAULT_POSTGRES_URL}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[eliza-test] WARN failed to prepare local PostgreSQL test database; plugin-sql Postgres-only suites may be skipped (${message})`,
    );
  }
}

function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scriptReferencesScript(command, scriptName) {
  if (!command) {
    return false;
  }
  const escapedName = escapeForRegex(scriptName);
  const referencePattern = new RegExp(
    `(?:^|[;&|]\\s*|&&\\s*|\\|\\|\\s*)(?:bun|npm|yarn)(?:\\s+run)?\\s+${escapedName}(?:\\s|$)`,
  );
  return referencePattern.test(command);
}

function getReferencedScriptNames(command, scripts) {
  if (!command) {
    return [];
  }

  const matches = [];
  const invocationPattern = /(?:bun|npm|yarn)(?:\s+run)?\s+([A-Za-z0-9:_-]+)/g;
  for (const match of command.matchAll(invocationPattern)) {
    const scriptName = match[1];
    if (scriptName && scripts?.[scriptName]) {
      matches.push(scriptName);
    }
  }
  return matches;
}

function isManualTestScript(scriptName) {
  return MANUAL_TEST_SCRIPT_PATTERN.test(scriptName);
}

function isE2EScriptName(scriptName) {
  return (
    scriptName === "test:e2e" ||
    scriptName.startsWith("test:e2e:") ||
    scriptName.endsWith(":e2e") ||
    scriptName.includes(":e2e:")
  );
}

function isE2ELikeScriptName(scriptName) {
  return (
    isE2EScriptName(scriptName) || E2E_COMPANION_SCRIPT_NAMES.has(scriptName)
  );
}

function orderScriptCandidates(scriptNames) {
  const priority = new Map(
    [
      "test:integration",
      "test:e2e:all",
      "test:e2e",
      "test:playwright",
      "test:ui",
      "test:live",
    ].map((scriptName, index) => [scriptName, index]),
  );

  return [...scriptNames].sort((left, right) => {
    const leftPriority = priority.get(left) ?? 100;
    const rightPriority = priority.get(right) ?? 100;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    return left.localeCompare(right);
  });
}

function collectAdditionalScriptCandidates(scripts) {
  const candidates = new Set();

  for (const scriptName of EXTRA_SCRIPT_NAMES) {
    if (scripts[scriptName]) {
      candidates.add(scriptName);
    }
  }

  for (const scriptName of Object.keys(scripts)) {
    if (isManualTestScript(scriptName)) {
      continue;
    }
    if (isE2EScriptName(scriptName)) {
      candidates.add(scriptName);
    }
  }

  return orderScriptCandidates(candidates);
}

function collectE2EScriptCandidates(scripts) {
  return collectAdditionalScriptCandidates(scripts).filter(isE2ELikeScriptName);
}

function scriptInvokesScript(
  entryScriptName,
  targetScriptName,
  scripts,
  seen = new Set(),
) {
  if (entryScriptName === targetScriptName) {
    return true;
  }
  if (seen.has(entryScriptName)) {
    return false;
  }
  seen.add(entryScriptName);

  const command = normalizeWhitespace(scripts?.[entryScriptName] ?? "");
  if (!command) {
    return false;
  }
  if (scriptReferencesScript(command, targetScriptName)) {
    return true;
  }

  for (const referencedScriptName of getReferencedScriptNames(
    command,
    scripts,
  )) {
    if (
      referencedScriptName !== entryScriptName &&
      scriptInvokesScript(referencedScriptName, targetScriptName, scripts, seen)
    ) {
      return true;
    }
  }

  return false;
}

function isCoveredBySelectedScript(scriptName, selectedScriptNames, scripts) {
  for (const selectedScriptName of selectedScriptNames) {
    if (selectedScriptName === scriptName) {
      continue;
    }
    if (scriptInvokesScript(selectedScriptName, scriptName, scripts)) {
      return true;
    }
    if (selectedScriptName === "test:e2e:all" && isE2EScriptName(scriptName)) {
      return true;
    }
    if (
      selectedScriptName === "test:e2e" &&
      scriptName.startsWith("test:e2e:")
    ) {
      return true;
    }
  }

  return false;
}

function appendScriptIfRunnable(
  scriptNames,
  seenCommands,
  scriptName,
  scripts,
) {
  const raw = normalizeWhitespace(scripts[scriptName] ?? "");
  if (!raw) {
    return;
  }

  if (isCoveredBySelectedScript(scriptName, scriptNames, scripts)) {
    return;
  }

  const resolved = resolveScriptCommand(scriptName, scripts) || raw;
  if (seenCommands.has(resolved)) {
    return;
  }

  scriptNames.push(scriptName);
  seenCommands.add(resolved);
}

function collectScriptsToRun(scripts) {
  const scriptNames = [];
  const seenCommands = new Set();

  if (selectedMode === "e2e") {
    for (const scriptName of collectE2EScriptCandidates(scripts)) {
      appendScriptIfRunnable(scriptNames, seenCommands, scriptName, scripts);
    }
    return scriptNames;
  }

  if (selectedMode === "test") {
    if (scripts.test) {
      scriptNames.push("test");
    }
    return scriptNames;
  }

  if (scripts.test) {
    const resolvedTestCommand =
      resolveScriptCommand("test", scripts) ||
      normalizeWhitespace(scripts.test);
    scriptNames.push("test");
    if (resolvedTestCommand) {
      seenCommands.add(resolvedTestCommand);
    }
  }

  for (const scriptName of collectAdditionalScriptCandidates(scripts)) {
    const raw = normalizeWhitespace(scripts[scriptName] ?? "");
    if (!raw) {
      continue;
    }

    if (scriptInvokesScript("test", scriptName, scripts)) {
      continue;
    }
    if (isCoveredBySelectedScript(scriptName, scriptNames, scripts)) {
      continue;
    }

    const resolved = resolveScriptCommand(scriptName, scripts) || raw;
    if (seenCommands.has(resolved)) {
      continue;
    }

    scriptNames.push(scriptName);
    seenCommands.add(resolved);
  }

  return scriptNames;
}

function appendCapturedOutput(current, chunk) {
  const next = `${current}${chunk}`;
  if (next.length <= MAX_CAPTURED_OUTPUT_CHARS) {
    return next;
  }
  return next.slice(-MAX_CAPTURED_OUTPUT_CHARS);
}

function outputIndicatesNoTests(output) {
  return NO_TEST_OUTPUT_PATTERNS.some((pattern) => pattern.test(output));
}

function hasLocalTestFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (TEST_FILE_SKIP_DIRS.has(entry.name)) {
        continue;
      }
      if (hasLocalTestFiles(path.join(dir, entry.name))) {
        return true;
      }
      continue;
    }

    if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
      return true;
    }
  }

  return false;
}

function isSingleVitestRunCommand(command) {
  const commandWithoutEnv = command.replace(
    /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/,
    "",
  );
  if (/[;&|]/.test(commandWithoutEnv)) {
    return false;
  }
  return (
    /^(?:(?:bunx|npx)\s+)?vitest\s+run\b/.test(commandWithoutEnv) ||
    /^bun\s+x\s+vitest\s+run\b/.test(commandWithoutEnv)
  );
}

function shouldSkipEmptyVitestScript(cwd, scriptName, scripts) {
  const command =
    resolveScriptCommand(scriptName, scripts) ||
    normalizeWhitespace(scripts?.[scriptName] ?? "");

  return isSingleVitestRunCommand(command) && !hasLocalTestFiles(cwd);
}

// ---------------------------------------------------------------------------
// Lane and shard support
// ---------------------------------------------------------------------------

/**
 * Compute which lane-specific env overrides to apply to a spawned process.
 *
 * - TEST_LANE=pr   → VITEST_EXCLUDE_REAL_E2E=1 + VITEST_EXCLUDE_REAL=1 so
 *   package vitest configs can drop `*.real.e2e.test.ts` and `*.real.test.ts`
 *   files (the real-API lane). pattern remains a regex string for callers
 *   that want to chain via `process.env`.
 * - TEST_LANE=post-merge → no exclusions; real keys flow through.
 * - --only=e2e     → VITEST_E2E_ONLY=1.
 * - --only=test or default mode → VITEST_UNIT_ONLY=1.
 * - --pattern      → VITEST_TEST_PATH_PATTERN forwarded for package scripts
 *   that respect it. (Most do, via the shared default vitest config; package
 *   scripts that don't will simply ignore the env var.)
 * - ELIZA_LIVE_TEST defaults to 0 for ordinary package `test` scripts. Set
 *   ELIZA_LIVE_TEST=1 explicitly, run TEST_LANE=post-merge, or run a
 *   `*:live` script to opt into live-provider behavior.
 */
function isLiveScriptName(scriptName) {
  return (
    scriptName === "test:live" ||
    scriptName.endsWith(":live") ||
    scriptName.includes(":live:")
  );
}

function resolveLiveTestValue(scriptName = "") {
  if (process.env.ELIZA_LIVE_TEST !== undefined) {
    return process.env.ELIZA_LIVE_TEST;
  }
  if (TEST_LANE === "post-merge" || isLiveScriptName(scriptName)) {
    return "1";
  }
  return "0";
}

function buildLaneEnv(scriptName = "") {
  const extra = {};

  if (TEST_LANE === "pr") {
    extra.VITEST_EXCLUDE_REAL_E2E = "1";
    extra.VITEST_EXCLUDE_REAL = "1";
    // Also expose a regex string so configs that compose includes/excludes
    // dynamically don't have to know two flag names.
    extra.VITEST_LANE = "pr";
  } else if (TEST_LANE === "post-merge") {
    extra.VITEST_LANE = "post-merge";
  }

  if (selectedMode === "e2e") {
    extra.VITEST_E2E_ONLY = "1";
  } else if (selectedMode === "test") {
    extra.VITEST_UNIT_ONLY = "1";
  }

  extra.ELIZA_LIVE_TEST = resolveLiveTestValue(scriptName);

  if (patternFlag) {
    // Forwarded to vitest via env so package-level configs / wrapper scripts
    // can apply --testPathPattern when needed without reflowing CLI args.
    extra.VITEST_TEST_PATH_PATTERN = patternFlag;
  }

  return extra;
}

function getDefaultTaskSkipReason(relativeDir, scriptName) {
  if (scriptName === "test:ui" && process.env.ELIZA_INCLUDE_TEST_UI !== "1") {
    return "Vitest UI is an interactive server; set ELIZA_INCLUDE_TEST_UI=1";
  }
  if (
    isLiveScriptName(scriptName) &&
    TEST_LANE !== "post-merge" &&
    process.env.ELIZA_INCLUDE_LIVE_TESTS !== "1" &&
    process.env.ELIZA_LIVE_TEST !== "1"
  ) {
    return "Live-provider tests are opt-in; run TEST_LANE=post-merge or set ELIZA_INCLUDE_LIVE_TESTS=1";
  }
  if (
    relativeDir === "packages/app-core/platforms/electrobun" &&
    scriptName === "test" &&
    process.env.ELIZA_INCLUDE_ELECTROBUN_TESTS !== "1"
  ) {
    return "Electrobun-only tests are opt-in; set ELIZA_INCLUDE_ELECTROBUN_TESTS=1";
  }
  return null;
}

/**
 * Stable shard membership: SHA-1 of the task's relative package dir → bucket
 * → assign to shard N (1-indexed) of M. Hashing the relative dir (rather than
 * the full label) keeps a package's `test` and `test:e2e` tasks in the same
 * shard, which keeps Postgres + mock startup costs amortised across the
 * package's full task set.
 */
function taskBelongsToShard(taskKey, shardCfg) {
  if (!shardCfg) return true;
  const hash = crypto.createHash("sha1").update(taskKey).digest("hex");
  const bucket = parseInt(hash.slice(0, 8), 16) % shardCfg.total;
  return bucket === shardCfg.index - 1;
}

function taskMatchesSelection(label, scriptName, taskKey) {
  if (packageFilters.some((rx) => !rx.test(label))) {
    return false;
  }
  if (scriptFilter && !scriptFilter.test(scriptName)) {
    return false;
  }
  return taskBelongsToShard(taskKey, shardConfig);
}

// ---------------------------------------------------------------------------
// Script runner
// ---------------------------------------------------------------------------

function runScript(cwd, scriptName, label, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bunCmd, ["run", scriptName], {
      cwd,
      env: {
        ...testRuntimeEnv,
        NODE_NO_WARNINGS: testRuntimeEnv.NODE_NO_WARNINGS || "1",
        ELIZA_LIVE_TEST: testRuntimeEnv.ELIZA_LIVE_TEST || "0",
        PWD: cwd,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let capturedOutput = "";
    let timedOut = false;
    const timeoutMs = Number.parseInt(
      process.env.ELIZA_TEST_TASK_TIMEOUT_MS ?? `${DEFAULT_TASK_TIMEOUT_MS}`,
      10,
    );
    const timeout =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
          }, timeoutMs)
        : null;
    timeout?.unref();

    child.stdout?.on("data", (chunk) => {
      process.stdout.write(chunk);
      capturedOutput = appendCapturedOutput(
        capturedOutput,
        chunk.toString("utf8"),
      );
    });
    child.stderr?.on("data", (chunk) => {
      process.stderr.write(chunk);
      capturedOutput = appendCapturedOutput(
        capturedOutput,
        chunk.toString("utf8"),
      );
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        return;
      }
      if (code === 0) {
        resolve({ skipped: false });
        return;
      }
      if (outputIndicatesNoTests(capturedOutput)) {
        resolve({ skipped: true });
        return;
      }
      reject(
        new Error(
          `${label} failed with ${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`}`,
        ),
      );
    });
  });
}

function runDirectTask(label, command, args, cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...testRuntimeEnv,
        NODE_NO_WARNINGS: testRuntimeEnv.NODE_NO_WARNINGS || "1",
        ELIZA_LIVE_TEST: testRuntimeEnv.ELIZA_LIVE_TEST || "0",
        PWD: cwd,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let capturedOutput = "";
    let timedOut = false;
    const timeoutMs = Number.parseInt(
      process.env.ELIZA_TEST_TASK_TIMEOUT_MS ?? `${DEFAULT_TASK_TIMEOUT_MS}`,
      10,
    );
    const timeout =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
          }, timeoutMs)
        : null;
    timeout?.unref();

    child.stdout?.on("data", (chunk) => {
      process.stdout.write(chunk);
      capturedOutput = appendCapturedOutput(
        capturedOutput,
        chunk.toString("utf8"),
      );
    });
    child.stderr?.on("data", (chunk) => {
      process.stderr.write(chunk);
      capturedOutput = appendCapturedOutput(
        capturedOutput,
        chunk.toString("utf8"),
      );
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        return;
      }
      if (code === 0) {
        resolve({ skipped: false });
        return;
      }
      if (outputIndicatesNoTests(capturedOutput)) {
        resolve({ skipped: true });
        return;
      }
      reject(
        new Error(
          `${label} failed with ${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`}`,
        ),
      );
    });
  });
}

async function runRepoVitestE2E(extraEnv = {}) {
  const configName =
    TEST_LANE === "post-merge" ? "live-e2e.config.ts" : "e2e.config.ts";
  const runVitestScript = path
    .relative(outerRepoRoot, path.join(repoRoot, "scripts", "run-vitest.mjs"))
    .split(path.sep)
    .join("/");
  const configPath = path
    .relative(outerRepoRoot, path.join(repoRoot, "test", "vitest", configName))
    .split(path.sep)
    .join("/");
  const label = `repo#vitest:${configName}`;

  console.log(`[eliza-test] START ${label}`);
  const startedAt = Date.now();
  const result = await runDirectTask(
    label,
    "node",
    [runVitestScript, "run", "--config", configPath],
    outerRepoRoot,
    extraEnv,
  );
  const durationMs = Date.now() - startedAt;
  if (result.skipped) {
    console.log(
      `[eliza-test] SKIP ${label} (${durationMs}ms, no test files found)`,
    );
    return;
  }
  console.log(`[eliza-test] PASS ${label} (${durationMs}ms)`);
}

// ---------------------------------------------------------------------------
// Cloud step
// ---------------------------------------------------------------------------

function runCloudTests() {
  return new Promise((resolve, reject) => {
    const cloudDir = path.join(repoRoot, "cloud");
    if (!fs.existsSync(cloudDir)) {
      console.log("[eliza-test] SKIP cloud (cloud/ directory not found)");
      resolve({ skipped: true });
      return;
    }
    const cloudPackageJsonPath = path.join(cloudDir, "package.json");
    const cloudPackageJson = JSON.parse(
      fs.readFileSync(cloudPackageJsonPath, "utf8"),
    );
    const scriptName = allFlag
      ? "test:full"
      : selectedMode === "e2e"
        ? "test:e2e:all"
        : "test";
    if (!cloudPackageJson.scripts?.[scriptName]) {
      console.log(`[eliza-test] SKIP cloud#${scriptName} (script not found)`);
      resolve({ skipped: true });
      return;
    }

    console.log(`[eliza-test] START cloud#${scriptName}`);
    const startedAt = Date.now();
    const child = spawn(bunCmd, ["run", scriptName], {
      cwd: cloudDir,
      env: {
        ...testRuntimeEnv,
        NODE_NO_WARNINGS: testRuntimeEnv.NODE_NO_WARNINGS || "1",
        ELIZA_LIVE_TEST: testRuntimeEnv.ELIZA_LIVE_TEST || "0",
        PWD: cloudDir,
        ...buildLaneEnv(scriptName),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let capturedOutput = "";
    child.stdout?.on("data", (chunk) => {
      process.stdout.write(chunk);
      capturedOutput = appendCapturedOutput(
        capturedOutput,
        chunk.toString("utf8"),
      );
    });
    child.stderr?.on("data", (chunk) => {
      process.stderr.write(chunk);
      capturedOutput = appendCapturedOutput(
        capturedOutput,
        chunk.toString("utf8"),
      );
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      const durationMs = Date.now() - startedAt;
      if (code === 0) {
        console.log(`[eliza-test] PASS cloud#${scriptName} (${durationMs}ms)`);
        resolve({ skipped: false });
        return;
      }
      if (outputIndicatesNoTests(capturedOutput)) {
        console.log(
          `[eliza-test] SKIP cloud#${scriptName} (${durationMs}ms, no test files found)`,
        );
        resolve({ skipped: true });
        return;
      }
      reject(
        new Error(
          `cloud#${scriptName} failed with ${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`}`,
        ),
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (
  allFlag ||
  selectedMode === "e2e" ||
  process.env.ELIZA_PREPARE_PLUGIN_SQL_POSTGRES === "1"
) {
  ensurePluginSqlPostgresEnv();
}

const packageJsonPaths = collectPackageJsonPaths();

let started = startAt.length === 0;

for (const packageJsonPath of packageJsonPaths) {
  const cwd = path.dirname(packageJsonPath);
  const relativeDir = path.relative(repoRoot, cwd) || ".";
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const scripts = packageJson.scripts ?? {};
  const scriptNames = collectScriptsToRun(scripts);

  if (scriptNames.length === 0) {
    continue;
  }

  const packageLabel = packageJson.name || relativeDir;
  for (const scriptName of scriptNames) {
    const label = `${packageLabel} (${relativeDir})#${scriptName}`;
    if (!started) {
      if (label.includes(startAt)) {
        started = true;
      } else {
        continue;
      }
    }
    // Shard filtering: deterministic by relative package dir hash. Keeps a
    // package's `test` + `test:e2e` tasks colocated in the same shard.
    if (!taskMatchesSelection(label, scriptName, relativeDir)) {
      continue;
    }
    const defaultTaskSkipReason = getDefaultTaskSkipReason(
      relativeDir,
      scriptName,
    );
    if (defaultTaskSkipReason) {
      console.log(`[eliza-test] SKIP ${label} (${defaultTaskSkipReason})`);
      continue;
    }
    if (shouldSkipEmptyVitestScript(cwd, scriptName, scripts)) {
      console.log(
        `[eliza-test] SKIP ${label} (no local test files for vitest script)`,
      );
      continue;
    }

    const extraEnv = buildLaneEnv(scriptName);

    console.log(`[eliza-test] START ${label}`);
    const startedAt = Date.now();
    const result = await runScript(cwd, scriptName, label, extraEnv);
    const durationMs = Date.now() - startedAt;
    if (result.skipped) {
      console.log(
        `[eliza-test] SKIP ${label} (${durationMs}ms, no test files found)`,
      );
      continue;
    }
    console.log(`[eliza-test] PASS ${label} (${durationMs}ms)`);
  }
}

if (selectedMode !== "test") {
  const repoE2ELabel = "repo (.)#test:e2e";
  if (!started && repoE2ELabel.includes(startAt)) {
    started = true;
  }
  if (started && taskMatchesSelection(repoE2ELabel, "test:e2e", "repo:e2e")) {
    await runRepoVitestE2E(buildLaneEnv());
  }
}

// Final stage: cloud tests (unless --no-cloud was passed)
if (!noCloud) {
  await runCloudTests();
}
