import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const [packageDirArg, ...assetPaths] = process.argv.slice(2);

if (!packageDirArg || assetPaths.length === 0) {
  console.error(
    "usage: node scripts/copy-package-assets.mjs <package-dir> <src-path> [<src-path> ...]",
  );
  process.exit(1);
}

const packageDir = path.resolve(repoRoot, packageDirArg);
const distDir = path.join(packageDir, "dist");
const COPY_RETRY_ATTEMPTS = 3;
const COPY_RETRY_DELAY_MS = 100;
const EXCLUDED_ASSET_DIRS = new Set([
  ".gradle",
  ".kotlin",
  ".turbo",
  "artifacts",
  "build",
  "dist",
  "node_modules",
]);

function shouldCopyAsset(src) {
  const relative = path.relative(packageDir, src);
  if (!relative || relative.startsWith("..")) {
    return true;
  }
  return !relative
    .split(path.sep)
    .some((segment) => EXCLUDED_ASSET_DIRS.has(segment));
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

async function copyAssetWithRetry(sourcePath, targetPath) {
  let lastError;
  for (let attempt = 1; attempt <= COPY_RETRY_ATTEMPTS; attempt++) {
    try {
      if (existsSync(targetPath)) {
        rmSync(targetPath, { recursive: true, force: true });
      }
      mkdirSync(path.dirname(targetPath), { recursive: true });
      cpSync(sourcePath, targetPath, {
        recursive: true,
        filter: shouldCopyAsset,
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

for (const assetPath of assetPaths) {
  const sourcePath = path.join(packageDir, assetPath);
  if (!existsSync(sourcePath)) {
    // Some asset directories (e.g. generated i18n/locales, optional
    // platform packaging) only exist after a separate generator runs.
    // Don't hard-fail the package build if they're absent.
    console.warn(`[copy-package-assets] skipping missing asset: ${sourcePath}`);
    continue;
  }

  const relativeTarget = assetPath.replace(/^src\//, "");
  const targetPath = path.join(distDir, relativeTarget);
  await copyAssetWithRetry(sourcePath, targetPath);
}
