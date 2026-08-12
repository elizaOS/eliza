#!/usr/bin/env node
/**
 * Per-package testing coverage matrix generator for issue #9943.
 *
 * Walks every workspace package using tracked files from `git ls-files`, counts
 * test/spec files and skipped tests, and records whether the package exposes the
 * `test` script used by the root workspace runner. Emits
 * docs/TESTING_COVERAGE_MATRIX.md.
 *
 * "In CI" is a heuristic: a package is swept by the root runner when it is a
 * workspace member with a `test` script and is not excluded from the root
 * workspace.
 *
 * Usage:
 *   node scripts/testing-coverage-matrix.mjs
 *   node scripts/testing-coverage-matrix.mjs --check
 *   node scripts/testing-coverage-matrix.mjs --output <path>
 *   node scripts/testing-coverage-matrix.mjs --help
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DEFAULT_OUTPUT = path.join(REPO_ROOT, "docs", "TESTING_COVERAGE_MATRIX.md");

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;
// it.skip / test.skip / describe.skip / xit / xdescribe / .todo / .skipIf(...)
const SKIP_RE =
  /\b(?:it|test|describe)\.(?:skip|todo)\b|\bx(?:it|describe)\s*\(|\.skipIf\s*\(|\btest\.skip\b/g;

export function gitFiles(rootDir = REPO_ROOT) {
  return execFileSync("git", ["ls-files"], {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { check: false, output: "", help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") {
      args.check = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--output") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error("Option '--output' requires a non-empty file path argument.");
      }
      args.output = argv[++i];
    } else if (arg.startsWith("--output=")) {
      const val = arg.slice("--output=".length);
      if (!val) {
        throw new Error("Option '--output' requires a non-empty file path argument.");
      }
      args.output = val;
    } else {
      throw new Error(`Unknown option or argument: ${arg}`);
    }
  }
  return args;
}

export function generateMatrixData(options = {}) {
  const rootDir = options.rootDir ?? REPO_ROOT;
  const files = options.files ?? gitFiles(rootDir);
  const readJsonFn =
    options.readJsonFn ??
    ((rel) => {
      try {
        return JSON.parse(readFileSync(path.join(rootDir, rel), "utf8"));
      } catch {
        return null;
      }
    });
  const readFileTextFn =
    options.readFileTextFn ??
    ((file) => {
      try {
        return readFileSync(path.join(rootDir, file), "utf8");
      } catch {
        return null;
      }
    });

  // Every directory that owns a package.json (excluding the repo root) is a
  // package node. Tracked files never include node_modules, so this is clean.
  const packageDirs = files
    .filter((f) => f.endsWith("/package.json") || f === "package.json")
    .map((f) => path.posix.dirname(f))
    .filter((dir) => dir !== ".")
    .sort();
  const packageDirSet = new Set(packageDirs);

  /** Deepest package dir that is an ancestor of `file` (or null). */
  function ownerPackage(file) {
    let dir = path.posix.dirname(file);
    while (dir !== "." && dir.length > 0) {
      if (packageDirSet.has(dir)) return dir;
      const next = path.posix.dirname(dir);
      if (next === dir) break;
      dir = next;
    }
    return null;
  }

  const rootPkg = readJsonFn("package.json");
  const workspaceNegations = (rootPkg?.workspaces ?? [])
    .filter((w) => typeof w === "string" && w.startsWith("!"))
    .map((w) => w.slice(1));
  const excludedFromRoot = (dir) =>
    workspaceNegations.some((neg) => dir === neg || dir.startsWith(`${neg}/`));

  const stats = new Map(
    packageDirs.map((dir) => [
      dir,
      { dir, name: null, testFiles: 0, skips: 0, hasTestScript: false },
    ]),
  );

  // Per-package package.json metadata.
  for (const dir of packageDirs) {
    const pkg = readJsonFn(`${dir}/package.json`);
    const entry = stats.get(dir);
    if (entry) {
      entry.name = pkg?.name ?? "(unnamed)";
      entry.hasTestScript = Boolean(pkg?.scripts?.test);
    }
  }

  // Assign test files to their owning package and count skips.
  for (const file of files) {
    if (!TEST_FILE_RE.test(file)) continue;
    const owner = ownerPackage(file);
    if (!owner) continue;
    const entry = stats.get(owner);
    if (!entry) continue;
    entry.testFiles += 1;
    const body = readFileTextFn(file);
    if (body) {
      const matches = body.match(SKIP_RE);
      if (matches) entry.skips += matches.length;
    }
  }

  const rows = [...stats.values()]
    .filter((e) => e.testFiles > 0 || e.hasTestScript)
    .sort((a, b) => a.dir.localeCompare(b.dir));

  const totals = rows.reduce(
    (acc, r) => {
      acc.testFiles += r.testFiles;
      acc.skips += r.skips;
      acc.withTests += r.testFiles > 0 ? 1 : 0;
      acc.inCi += r.hasTestScript && !excludedFromRoot(r.dir) ? 1 : 0;
      acc.zeroTestWithScript += r.testFiles === 0 && r.hasTestScript ? 1 : 0;
      return acc;
    },
    { testFiles: 0, skips: 0, withTests: 0, inCi: 0, zeroTestWithScript: 0 },
  );

  const lines = [];
  lines.push("# Testing coverage matrix");
  lines.push("");
  lines.push(
    "Per-package view of test presence, CI wiring, and skip debt. Generated by " +
      "`node scripts/testing-coverage-matrix.mjs` — do not hand-edit; re-run to refresh.",
  );
  lines.push("");
  lines.push("## Columns");
  lines.push("");
  lines.push(
    "- **Test files** — count of `*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}` owned by the package (assigned to the deepest enclosing package).",
  );
  lines.push(
    "- **Skips** — count of `it/test/describe.skip`, `.todo`, `x(it|describe)`, and `.skipIf(...)` markers across those files.",
  );
  lines.push(
    "- **`test` script** — package exposes a `test` script (the signal the root runner sweeps on).",
  );
  lines.push(
    "- **In CI (heuristic)** — has a `test` script AND is not excluded from the root workspace. Not a proof of execution; lane-level gating still applies.",
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Packages with tests: **${totals.withTests}**`);
  lines.push(
    `- Packages swept by the root runner (heuristic): **${totals.inCi}**`,
  );
  lines.push(`- Total test files: **${totals.testFiles}**`);
  lines.push(`- Total skipped tests: **${totals.skips}**`);
  lines.push(
    `- Packages with a \`test\` script but zero test files: **${totals.zeroTestWithScript}**`,
  );
  lines.push("");
  lines.push("## Matrix");
  lines.push("");
  lines.push(
    "| Package | Path | Test files | Skips | `test` script | In CI (heuristic) |",
  );
  lines.push("| --- | --- | ---: | ---: | :---: | :---: |");
  for (const r of rows) {
    const inCi = r.hasTestScript && !excludedFromRoot(r.dir);
    lines.push(
      `| ${r.name} | \`${r.dir}\` | ${r.testFiles} | ${r.skips} | ${r.hasTestScript ? "yes" : "no"} | ${inCi ? "yes" : "no"} |`,
    );
  }
  lines.push("");

  const content = `${lines.join("\n")}`;
  return { content, totals, rows };
}

export function runCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    stderr.write(`[testing-coverage-matrix] Error: ${err.message}\n`);
    stderr.write("Usage: node scripts/testing-coverage-matrix.mjs [--check] [--output <path>] [--help]\n");
    return 2;
  }

  if (args.help) {
    stdout.write(
      "Usage: node scripts/testing-coverage-matrix.mjs [options]\n\n" +
        "Options:\n" +
        "  --check          Verify that the matrix file is up to date instead of writing it\n" +
        "  --output <path>  Specify alternative destination path for the matrix file\n" +
        "  --help, -h       Show this help message\n",
    );
    return 0;
  }

  const outputPath = args.output ? path.resolve(args.output) : DEFAULT_OUTPUT;
  const { content, totals, rows } = generateMatrixData();

  if (args.check) {
    const current = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
    if (current !== content) {
      stderr.write(
        `${path.relative(REPO_ROOT, outputPath)} is stale. Run \`node scripts/testing-coverage-matrix.mjs\`.\n`,
      );
      return 1;
    }
    stdout.write(`${path.relative(REPO_ROOT, outputPath)} is up to date.\n`);
    return 0;
  }

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content);
  stdout.write(
    `Wrote ${path.relative(REPO_ROOT, outputPath)}: ${rows.length} packages, ` +
      `${totals.testFiles} test files, ${totals.skips} skips.\n`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = runCli();
}

