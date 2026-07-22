#!/usr/bin/env node
/** Typechecks every active-worktree consumer of the generated dist-path map. */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listSubmodules } from "./lib/workspaces.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const distPathsConfig = path.join(repoRoot, "tsconfig.dist-paths.json");
const ignoredDirs = new Set([
  ".git",
  ".next",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);
// Tooling creates complete sibling checkouts only in these root containers.
// Root scope matters because same-named directories may be first-party source.
const ignoredRootWorktreeDirs = new Set([
  ".worktrees",
  ".audit-worktrees",
  ".codex-agent-worktrees",
  ".codex-pr-worktrees",
  ".codex-worktrees",
]);

const localTsc = path.join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsc.cmd" : "tsc",
);
const tsc = existsSync(localTsc) ? localTsc : "tsc";

function walk(dir, root, submoduleDirs, out = []) {
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (ignoredDirs.has(entry.name)) continue;
    if (dir === root && ignoredRootWorktreeDirs.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    const stat = lstatSync(fullPath);
    if (stat.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (submoduleDirs.has(fullPath)) continue;
      walk(fullPath, root, submoduleDirs, out);
      continue;
    }
    if (/^tsconfig(?:\..*)?\.json$/.test(entry.name)) {
      out.push(fullPath);
    }
  }
  return out;
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function verifiedSubmoduleDirs(root) {
  const topLevel = git(root, ["rev-parse", "--show-toplevel"]).trim();
  if (realpathSync(topLevel) !== realpathSync(root)) {
    throw new Error(
      `Dist-path discovery root must be a Git repository root: ${root}`,
    );
  }

  const indexedPaths = new Set(
    git(root, ["ls-files", "--stage", "-z"])
      .split("\0")
      .filter(Boolean)
      .flatMap((entry) => {
        const match = entry.match(/^160000 [0-9a-f]+ 0\t([\s\S]+)$/u);
        return match ? [match[1]] : [];
      }),
  );

  // A .gitmodules declaration is only a repository boundary when the index
  // agrees that the path is a gitlink. Neither declaration nor marker alone
  // may suppress first-party configs from the verification gate.
  return new Set(
    listSubmodules({ repoRoot: root })
      .map((submodule) => submodule.path)
      .filter((submodulePath) => indexedPaths.has(submodulePath))
      .map((submodulePath) => path.resolve(root, submodulePath)),
  );
}

function readExtends(configPath) {
  const body = readFileSync(configPath, "utf8");
  const match = body.match(/"extends"\s*:\s*"([^"]+)"/);
  return match?.[1];
}

function extendsDistPaths(configPath, targetConfig) {
  const extendsValue = readExtends(configPath);
  if (!extendsValue) return false;
  return path.resolve(path.dirname(configPath), extendsValue) === targetConfig;
}

export function findDistPathConsumerConfigs(
  root,
  targetConfig = path.join(root, "tsconfig.dist-paths.json"),
) {
  const resolvedRoot = path.resolve(root);
  const resolvedTargetConfig = path.resolve(targetConfig);
  return walk(resolvedRoot, resolvedRoot, verifiedSubmoduleDirs(resolvedRoot))
    .filter((config) => extendsDistPaths(config, resolvedTargetConfig))
    .sort();
}

function main() {
  const configs = findDistPathConsumerConfigs(repoRoot, distPathsConfig);

  if (process.argv.includes("--list")) {
    for (const config of configs) {
      console.log(path.relative(repoRoot, config));
    }
    return;
  }

  if (configs.length === 0) {
    console.error(
      "[typecheck:dist] no tsconfig.dist-paths.json consumers found",
    );
    process.exitCode = 1;
    return;
  }

  for (const config of configs) {
    const rel = path.relative(repoRoot, config);
    console.log(`\n[typecheck:dist] ${rel}`);
    const result = spawnSync(
      tsc,
      ["--noEmit", "--pretty", "false", "-p", config],
      {
        cwd: repoRoot,
        env: process.env,
        stdio: "inherit",
      },
    );
    if (result.error) {
      console.error(
        `[typecheck:dist] failed to start ${tsc}: ${result.error.message}`,
      );
      process.exitCode = 1;
      return;
    }
    if (result.status !== 0) {
      console.error(
        `[typecheck:dist] failed in ${rel} with exit code ${result.status}`,
      );
      process.exitCode = result.status ?? 1;
      return;
    }
  }

  console.log(
    `\n[typecheck:dist] checked ${configs.length} dist-path consumer config(s)`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
