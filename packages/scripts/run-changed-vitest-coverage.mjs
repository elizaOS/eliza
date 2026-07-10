/**
 * Runs changed Vitest files through their nearest package configuration.
 *
 * The coverage gate executes before workspace builds, so combining unrelated
 * package tests under the root config can resolve absent dist entrypoints and
 * bypass package-specific aliases or setup. Each group writes an independent
 * LCOV report; the existing coverage gate merges every discovered report.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_NAMES = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.cts",
  "vitest.config.cjs",
];

const normalize = (value) => value.split(path.sep).join("/");

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

  let directory = path.dirname(absoluteTest);
  while (true) {
    for (const name of CONFIG_NAMES) {
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
      const reportSlug = (relativeDir || "root").replaceAll(
        /[^a-zA-Z0-9._-]+/g,
        "-",
      );
      return {
        configDir,
        configPath,
        reportDir: path.join(absoluteRoot, "coverage", "vitest", reportSlug),
        tests: tests.sort(),
      };
    });
}

export function normalizeLcovReport(repoRoot, configDir, reportDir) {
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
            path.resolve(configDir, sourcePath),
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
        `--coverage.reportsDirectory=${group.reportDir}`,
      ],
      {
        cwd: group.configDir,
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
    normalizeLcovReport(repoRoot, group.configDir, group.reportDir);
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
