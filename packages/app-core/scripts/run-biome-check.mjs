import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_CORE_ROOT = path.resolve(SCRIPT_DIR, "..");

const BIOME_CRASHER_PATHS = new Set([
  "eliza/packages/native-plugins/screencapture/src/web.ts",
  "eliza/packages/app-core/src/types/elizaos-tui-fallback.d.ts",
  "eliza/packages/app-core/src/types/optional-plugin-modules.d.ts",
  "scripts/type-audit-report.json",
  "scripts/type-audit-report.md",
]);

const BIOME_ROOTS = [
  "package.json",
  "bunfig.toml",
  "tsconfig.json",
  "scripts",
  "test",
  "apps",
  "eliza",
];
const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".next",
  ".turbo",
  ".vite",
  ".yarn",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "playwright-report",
  "test-results",
]);
// Windows shell invocations hit command length limits quickly. Keep chunks
// smaller there so `bunx biome check` can run reliably in pre-review hooks.
const BIOME_CHUNK_SIZE = process.platform === "win32" ? 40 : 200;
const BIOME_FILE_PATTERN =
  /\.(?:[cm]?js|[cm]?ts|jsx|tsx|json|jsonc|css|md|mdx)$/i;

function findRepoRoot(startDir) {
  let currentDir = startDir;
  let matchedRoot = null;

  while (true) {
    if (
      existsSync(path.join(currentDir, "package.json")) &&
      existsSync(path.join(currentDir, ".github", "workflows"))
    ) {
      matchedRoot = currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      if (matchedRoot) {
        return matchedRoot;
      }
      throw new Error(`Unable to resolve repository root from ${startDir}.`);
    }

    currentDir = parentDir;
  }
}

const REPO_ROOT = findRepoRoot(APP_CORE_ROOT);

function normalisePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function isNestedBiomeRoot(dirPath) {
  return dirPath !== REPO_ROOT && existsSync(path.join(dirPath, "biome.json"));
}

function collectBiomeFiles(rootPath, files) {
  if (!existsSync(rootPath)) {
    return;
  }

  const stats = statSync(rootPath);
  if (stats.isFile()) {
    const relPath = normalisePath(path.relative(REPO_ROOT, rootPath));
    if (
      !BIOME_CRASHER_PATHS.has(relPath) &&
      BIOME_FILE_PATTERN.test(relPath) &&
      existsSync(rootPath)
    ) {
      files.push(relPath);
    }
    return;
  }

  if (isNestedBiomeRoot(rootPath)) {
    return;
  }

  const queue = [rootPath];
  while (queue.length > 0) {
    const currentDir = queue.pop();
    if (!currentDir) {
      continue;
    }

    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || isNestedBiomeRoot(entryPath)) {
          continue;
        }
        queue.push(entryPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const relPath = normalisePath(path.relative(REPO_ROOT, entryPath));
      if (
        BIOME_CRASHER_PATHS.has(relPath) ||
        !BIOME_FILE_PATTERN.test(relPath) ||
        !existsSync(entryPath)
      ) {
        continue;
      }

      files.push(relPath);
    }
  }
}

function getBiomeFiles() {
  const files = [];
  for (const root of BIOME_ROOTS) {
    collectBiomeFiles(path.join(REPO_ROOT, root), files);
  }
  return [...new Set(files)].sort((a, b) => a.localeCompare(b));
}

function chunk(items, size) {
  const groups = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}

const files = getBiomeFiles();
if (files.length === 0) {
  console.error("[biome-check] No files matched the configured roots.");
  process.exit(1);
}

const extraArgs = process.argv.slice(2);
for (const group of chunk(files, BIOME_CHUNK_SIZE)) {
  const result = spawnSync(
    "bunx",
    ["@biomejs/biome", "check", ...extraArgs, ...group],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      shell: process.platform === "win32",
    },
  );

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (
    (result.status ?? 1) !== 0 &&
    combinedOutput.includes("No files were processed in the specified paths.")
  ) {
    continue;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
