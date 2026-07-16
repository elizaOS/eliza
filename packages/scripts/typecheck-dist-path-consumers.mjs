#!/usr/bin/env node
/** Typechecks every active-worktree consumer of the generated dist-path map. */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const localTsc = path.join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsc.cmd" : "tsc",
);
const tsc = existsSync(localTsc) ? localTsc : "tsc";

function walk(dir, root, out = []) {
  // Submodules and linked worktrees are independent repositories. Descending
  // into them duplicates discovery and can turn a root verification into a
  // scan of hundreds of complete checkouts on multi-lane hosts.
  if (dir !== root && existsSync(path.join(dir, ".git"))) return out;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (ignoredDirs.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    let stat;
    try {
      stat = lstatSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walk(fullPath, root, out);
      continue;
    }
    if (/^tsconfig(?:\..*)?\.json$/.test(entry.name)) {
      out.push(fullPath);
    }
  }
  return out;
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
  return walk(root, root)
    .filter((config) => extendsDistPaths(config, targetConfig))
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
