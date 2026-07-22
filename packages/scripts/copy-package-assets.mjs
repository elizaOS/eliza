/** Copies publishable package assets while excluding generated local state. */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

const COPY_RETRY_ATTEMPTS = 3;
const COPY_RETRY_DELAY_MS = 100;
const EXCLUDED_ASSET_DIRS = new Set([
  ".gradle",
  ".kotlin",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".turbo",
  ".venv",
  "ENV",
  "__pycache__",
  "artifacts",
  "build",
  "dist",
  "env",
  "node_modules",
  "venv",
]);
const EXCLUDED_ASSET_EXTENSIONS = new Set([".pyc", ".pyo"]);

export function shouldCopyAsset(packageDir, src) {
  const relative = path.relative(packageDir, src);
  if (!relative || relative.startsWith("..")) {
    return true;
  }
  const segments = relative.split(path.sep);
  const leaf = segments.at(-1) ?? "";
  return (
    !segments.some(
      (segment) =>
        EXCLUDED_ASSET_DIRS.has(segment) || segment.endsWith(".egg-info"),
    ) &&
    !leaf.startsWith(".coverage") &&
    !EXCLUDED_ASSET_EXTENSIONS.has(path.extname(leaf))
  );
}

function shouldRetryCopy(error, sourcePath, attempt) {
  return (
    attempt < COPY_RETRY_ATTEMPTS &&
    error &&
    typeof error === "object" &&
    ["EBUSY", "ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code) &&
    existsSync(sourcePath)
  );
}

function removePathRecursive(repositoryRoot, targetPath) {
  const cleanupHelperScript = path.join(
    repositoryRoot,
    "packages",
    "scripts",
    "rm-path-recursive.mjs",
  );
  const completed = spawnSync(
    "node",
    [cleanupHelperScript, path.relative(repositoryRoot, targetPath)],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (completed.error) throw completed.error;
  if (completed.status !== 0) {
    throw new Error(
      [
        `failed to remove ${targetPath}`,
        completed.stdout.trim(),
        completed.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

async function copyAssetWithRetry({
  repositoryRoot,
  packageDir,
  sourcePath,
  targetPath,
}) {
  let lastError;
  for (let attempt = 1; attempt <= COPY_RETRY_ATTEMPTS; attempt++) {
    try {
      if (existsSync(targetPath)) {
        removePathRecursive(repositoryRoot, targetPath);
      }
      mkdirSync(path.dirname(targetPath), { recursive: true });
      cpSync(sourcePath, targetPath, {
        recursive: true,
        filter: (src) => shouldCopyAsset(packageDir, src),
      });
      return;
    } catch (error) {
      lastError = error;
      if (!shouldRetryCopy(error, sourcePath, attempt)) {
        break;
      }
      await sleep(COPY_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

export async function copyPackageAssets({
  repositoryRoot,
  packageDirectory,
  assetPaths,
}) {
  if (
    !packageDirectory ||
    !Array.isArray(assetPaths) ||
    assetPaths.length === 0
  ) {
    throw new TypeError(
      "usage: node packages/scripts/copy-package-assets.mjs <package-dir> <src-path> [<src-path> ...]",
    );
  }
  const packageDir = path.resolve(repositoryRoot, packageDirectory);
  const distDir = path.join(packageDir, "dist");

  for (const assetPath of assetPaths) {
    const sourcePath = path.join(packageDir, assetPath);
    if (!existsSync(sourcePath)) {
      throw new Error(`missing asset path: ${sourcePath}`);
    }

    const relativeTarget = assetPath.replace(/^src\//, "");
    const targetPath = path.join(distDir, relativeTarget);
    await copyAssetWithRetry({
      repositoryRoot,
      packageDir,
      sourcePath,
      targetPath,
    });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [packageDirectory, ...assetPaths] = process.argv.slice(2);
    await copyPackageAssets({
      repositoryRoot: repoRoot,
      packageDirectory,
      assetPaths,
    });
  } catch (error) {
    // error-policy:J1 the CLI boundary exposes invalid inputs or copy failures
    // to the invoking build instead of leaving a partial package silently.
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
