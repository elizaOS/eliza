/**
 * Runs changed Vitest files through their nearest package configuration.
 *
 * The coverage gate executes before workspace builds, so combining unrelated
 * package tests under the root config can resolve absent dist entrypoints and
 * bypass package-specific aliases or setup. Each group runs in isolation, and
 * the per-group LCOV reports are then union-merged into a single
 * `coverage/vitest/lcov.info` (see {@link mergeAndRemoveLcovReports}) so the
 * gate sees one record per file across every group that executed it.
 *
 * Two path-resolution rules make nested and specialty configs runnable:
 * `*.harness.test.ts` files prefer the repo's `vitest.harness.config.ts`
 * convention (the plain package config deliberately EXCLUDES harness tests,
 * so grouping one there exits "no test files"), and each group runs with the
 * owning package directory as cwd — a config nested below the package root
 * (e.g. `packages/test/harness/vitest.config.ts`) declares `include` patterns
 * relative to the package script's cwd, not the config's own directory.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeAndRemoveLcovReports } from "./merge-lcov-reports.mjs";

const CONFIG_NAMES = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.cts",
  "vitest.config.cjs",
];

// PGLite-runtime harness suites are excluded from plain package configs and
// carry their own config with the workspace source-alias set.
const HARNESS_CONFIG_NAME = "vitest.harness.config.ts";
const HARNESS_TEST_SUFFIXES = [".harness.test.ts", ".harness.test.tsx"];

// The Electrobun desktop shell lives under platforms/electrobun as an isolated
// sub-tree. The owning app-core config deliberately excludes
// `platforms/electrobun/**` (its suites need the electrobun/bun stub alias), so
// grouping one there exits "no test files found". The platform carries its own
// `vitest.electrobun.config.ts`; prefer it for any test under that sub-tree.
const ELECTROBUN_CONFIG_NAME = "vitest.electrobun.config.ts";
const ELECTROBUN_DIR_SEGMENT = `${path.sep}platforms${path.sep}electrobun${path.sep}`;

const normalize = (value) => value.split(path.sep).join("/");

function isHarnessTest(testFile) {
  return HARNESS_TEST_SUFFIXES.some((suffix) => testFile.endsWith(suffix));
}

function isElectrobunTest(absoluteTest) {
  return normalize(absoluteTest).includes(normalize(ELECTROBUN_DIR_SEGMENT));
}

export function findNearestVitestConfig(repoRoot, testFile) {
  const absoluteRoot = path.resolve(repoRoot);
  const absoluteTest = path.resolve(absoluteRoot, testFile);
  const relativeTest = path.relative(absoluteRoot, absoluteTest);
  if (
    relativeTest === ".." ||
    relativeTest.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTest)
  ) {
    throw new Error(`Changed test escapes the repository: ${testFile}`);
  }

  let configNames = CONFIG_NAMES;
  if (isHarnessTest(absoluteTest)) {
    configNames = [HARNESS_CONFIG_NAME, ...CONFIG_NAMES];
  } else if (isElectrobunTest(absoluteTest)) {
    configNames = [ELECTROBUN_CONFIG_NAME, ...CONFIG_NAMES];
  }

  let directory = path.dirname(absoluteTest);
  while (true) {
    for (const name of configNames) {
      const candidate = path.join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
    if (directory === absoluteRoot) break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  throw new Error(`No Vitest config found for changed test: ${testFile}`);
}

export function findNearestPackageDir(repoRoot, configDir) {
  const absoluteRoot = path.resolve(repoRoot);
  let directory = path.resolve(configDir);
  while (true) {
    if (existsSync(path.join(directory, "package.json"))) return directory;
    if (directory === absoluteRoot) return absoluteRoot;
    const parent = path.dirname(directory);
    if (parent === directory) return absoluteRoot;
    directory = parent;
  }
}

export function groupChangedVitestTests(repoRoot, testFiles) {
  const absoluteRoot = path.resolve(repoRoot);
  const groups = new Map();

  for (const testFile of testFiles) {
    const configPath = findNearestVitestConfig(absoluteRoot, testFile);
    const absoluteTest = path.resolve(absoluteRoot, testFile);
    const tests = groups.get(configPath) ?? [];
    tests.push(absoluteTest);
    groups.set(configPath, tests);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([configPath, tests]) => {
      const configDir = path.dirname(configPath);
      const relativeDir = normalize(path.relative(absoluteRoot, configDir));
      // A non-default config (vitest.harness.config.ts) can share a directory
      // with the default one; suffix its slug so the two groups' LCOV reports
      // do not clobber each other. Default-config slugs stay unchanged.
      const configBase = path.basename(configPath);
      const slugSuffix = CONFIG_NAMES.includes(configBase)
        ? ""
        : `-${path.basename(configBase, path.extname(configBase))}`;
      const reportSlug = `${relativeDir || "root"}${slugSuffix}`.replaceAll(
        /[^a-zA-Z0-9._-]+/g,
        "-",
      );
      return {
        configDir,
        configPath,
        packageDir: findNearestPackageDir(absoluteRoot, configDir),
        reportDir: path.join(absoluteRoot, "coverage", "vitest", reportSlug),
        tests: tests.sort(),
      };
    });
}

export function normalizeLcovReport(repoRoot, baseDir, reportDir) {
  const lcovPath = path.join(reportDir, "lcov.info");
  if (!existsSync(lcovPath)) return;

  const absoluteRoot = path.resolve(repoRoot);
  const normalized = readFileSync(lcovPath, "utf8")
    .split("\n")
    .map((line) => {
      if (!line.startsWith("SF:")) return line;
      const sourcePath = line.slice("SF:".length);
      const candidates = path.isAbsolute(sourcePath)
        ? [sourcePath]
        : [
            path.resolve(baseDir, sourcePath),
            path.resolve(absoluteRoot, sourcePath),
          ];
      const existing = candidates.find((candidate) => existsSync(candidate));
      if (!existing) return line;
      const relative = path.relative(absoluteRoot, existing);
      if (relative.startsWith("..") || path.isAbsolute(relative)) return line;
      return `SF:${normalize(relative)}`;
    })
    .join("\n");
  writeFileSync(lcovPath, normalized);
}

export function runChangedVitestCoverage(repoRoot, testFiles) {
  const groups = groupChangedVitestTests(repoRoot, testFiles);
  for (const group of groups) {
    const result = spawnSync(
      "bunx",
      [
        "vitest",
        "run",
        ...group.tests,
        "--config",
        group.configPath,
        "--coverage",
        "--coverage.reporter=lcov",
        // Package configs carry whole-suite global thresholds. This lane runs
        // only changed files and applies its stricter changed-source floor in
        // coverage-gate.awk after merging the per-package LCOV reports.
        "--coverage.thresholds.lines=0",
        "--coverage.thresholds.functions=0",
        "--coverage.thresholds.statements=0",
        "--coverage.thresholds.branches=0",
        // Cross-package suites (the PGLite runtime harness) execute workspace
        // sources OUTSIDE the package root via source aliases; without this
        // flag that real execution is invisible to the changed-file gate.
        "--coverage.allowExternal=true",
        `--coverage.reportsDirectory=${group.reportDir}`,
      ],
      {
        // Run from the owning package (not the config's directory): package
        // scripts invoke nested configs from the package root, and relative
        // `include` patterns resolve against the cwd.
        cwd: group.packageDir,
        env: process.env,
        stdio: "inherit",
      },
    );

    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `Vitest coverage failed for ${normalize(path.relative(repoRoot, group.configDir)) || "root"} (exit ${result.status ?? "signal"})`,
      );
    }
    normalizeLcovReport(repoRoot, group.packageDir, group.reportDir);
  }

  // Collapse per-group reports into one union record per file, then remove the
  // group files: the workflow feeds every `coverage/**/lcov.info` to the gate,
  // and a leftover per-group report would re-introduce the low-occurrence
  // latch the merge exists to fix.
  const groupReports = groups.map((group) =>
    path.join(group.reportDir, "lcov.info"),
  );
  if (groupReports.length > 0) {
    mergeAndRemoveLcovReports(
      groupReports,
      path.join(path.resolve(repoRoot), "coverage", "vitest", "lcov.info"),
    );
  }
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  const testFiles = process.argv.slice(2).filter(Boolean);
  if (testFiles.length === 0) {
    throw new Error("At least one changed Vitest file is required.");
  }
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  runChangedVitestCoverage(repoRoot, testFiles);
}
