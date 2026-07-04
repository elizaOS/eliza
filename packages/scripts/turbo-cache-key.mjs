#!/usr/bin/env node
// Drives repo automation turbo cache key with explicit CLI and CI behavior.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listWorkspaceDirs as listWorkspaceDirsFromSeam } from "./lib/workspaces.mjs";

const DEFAULT_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const HASH_VERSION = "turbo-cache-key-v1";

const ROOT_INPUTS = new Set([
  ".biomeignore",
  "biome.json",
  "bun.lock",
  "bunfig.toml",
  "package.json",
  "tsconfig.base.json",
  "tsconfig.json",
  "turbo.json",
  ".github/actions/setup-bun-workspace/action.yml",
  ".github/workflows/release.yaml",
  "packages/scripts/turbo-cache-key.mjs",
  "packages/scripts/rewrite-dist-relative-imports-node-esm.mjs",
  "packages/scripts/view-bundle-vite.config.ts",
  "plugins/tsup.plugin-packages.shared.ts",
]);

const ROOT_PREFIX_INPUTS = ["packages/scripts/", "scripts/"];

const PACKAGE_INPUT_DIRS = new Set([
  "__tests__",
  "assets",
  "migrations",
  "prompts",
  "public",
  "scripts",
  "specs",
  "src",
  "test",
  "tests",
]);

const PACKAGE_ROOT_FILES = new Set([
  "build.mjs",
  "build.ts",
  "build.config.ts",
  "index.browser.ts",
  "index.node.ts",
  "index.ts",
  "package.json",
  "tsdown.config.ts",
  "tsup.config.ts",
  "vite.config.ts",
]);

const FALLBACK_IGNORED_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "storybook-static",
]);

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

// Workspace members, sorted longest-path-first so `owningWorkspace` attributes a
// file to its most-specific enclosing workspace (a nested member wins over its
// ancestor). Discovery itself is the shared seam.
export function listWorkspaceDirs(repoRoot = DEFAULT_REPO_ROOT) {
  return listWorkspaceDirsFromSeam({ repoRoot }).sort(
    (a, b) => b.length - a.length || a.localeCompare(b),
  );
}

function packageRootInput(fileName) {
  if (PACKAGE_ROOT_FILES.has(fileName)) return true;
  if (/^tsconfig(\..*)?\.json$/.test(fileName)) return true;
  if (/^tsup\.config(\..*)?\.ts$/.test(fileName)) return true;
  if (/^vite\.config(\..*)?\.ts$/.test(fileName)) return true;
  if (/^vitest\.config(\..*)?\.[cm]?[tj]s$/.test(fileName)) return true;
  return false;
}

function owningWorkspace(relativePath, workspaceDirs) {
  for (const dir of workspaceDirs) {
    if (relativePath === dir || relativePath.startsWith(`${dir}/`)) return dir;
  }
  return null;
}

export function isTurboCacheInputFile(relativePath, workspaceDirs = []) {
  const rel = normalizePath(relativePath);
  if (ROOT_INPUTS.has(rel)) return true;
  if (ROOT_PREFIX_INPUTS.some((prefix) => rel.startsWith(prefix))) return true;

  const workspaceDir = owningWorkspace(rel, workspaceDirs);
  if (!workspaceDir) return false;

  const insidePackage = rel.slice(workspaceDir.length + 1);
  if (!insidePackage || insidePackage.includes("/")) {
    const [firstSegment] = insidePackage.split("/");
    return PACKAGE_INPUT_DIRS.has(firstSegment);
  }
  return packageRootInput(insidePackage);
}

function listGitFiles(repoRoot) {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "buffer",
  });
  if (result.status !== 0) return null;
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(normalizePath);
}

function walkFiles(repoRoot, dir = repoRoot, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && FALLBACK_IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    let stat;
    try {
      stat = lstatSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      walkFiles(repoRoot, fullPath, out);
    } else if (stat.isFile()) {
      out.push(normalizePath(path.relative(repoRoot, fullPath)));
    }
  }
  return out;
}

export function listTurboCacheInputFiles(repoRoot = DEFAULT_REPO_ROOT) {
  const workspaceDirs = listWorkspaceDirs(repoRoot);
  const files = listGitFiles(repoRoot) ?? walkFiles(repoRoot);
  return files
    .filter((file) => isTurboCacheInputFile(file, workspaceDirs))
    .filter((file) => existsSync(path.join(repoRoot, file)))
    .sort((a, b) => a.localeCompare(b));
}

export function hashFileRecords(records) {
  const hash = createHash("sha256");
  hash.update(`${HASH_VERSION}\0`);
  for (const record of [...records].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  )) {
    hash.update(record.relativePath);
    hash.update("\0");
    hash.update(record.bytes);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 24);
}

export function computeTurboCacheKey(repoRoot = DEFAULT_REPO_ROOT) {
  const files = listTurboCacheInputFiles(repoRoot);
  const records = files.map((relativePath) => ({
    relativePath,
    bytes: readFileSync(path.join(repoRoot, relativePath)),
  }));
  return {
    files,
    hash: hashFileRecords(records),
  };
}

function printHelp() {
  console.log(`Usage: node packages/scripts/turbo-cache-key.mjs [options]

Options:
  --github-output  Write turbo_cache_key=<hash> to $GITHUB_OUTPUT.
  --json           Print {"hash","files"} for debugging.
  --list           Print the files included in the hash.
  --help           Show this help.
`);
}

if (import.meta.main || process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help")) {
    printHelp();
    process.exit(0);
  }

  const result = computeTurboCacheKey();
  if (args.has("--github-output")) {
    const outputPath = process.env.GITHUB_OUTPUT;
    if (!outputPath) {
      console.error("[turbo-cache-key] GITHUB_OUTPUT is not set");
      process.exit(1);
    }
    appendFileSync(outputPath, `turbo_cache_key=${result.hash}\n`);
    console.log(
      `[turbo-cache-key] ${result.hash} (${result.files.length} input file(s))`,
    );
  } else if (args.has("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else if (args.has("--list")) {
    console.log(result.files.join("\n"));
  } else {
    console.log(result.hash);
  }
}
