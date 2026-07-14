/** Copies publishable package assets while excluding generated local state. */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

const cleanupHelperScript = path.join(
  repoRoot,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);
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
const GENERATED_PACKAGING_OUTPUTS = [
  "packaging/debian/node-runtime",
  "packaging/debian/runtime",
  "packaging/flatpak/runtime",
  "packaging/snap/runtime",
];

/**
 * Filter for cpSync: keeps source assets, drops generated local state
 * (dependency dirs, caches, Python bytecode/venvs, transient
 * prepare-packaged-runtime staging, and committed packaging output trees).
 */
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
        EXCLUDED_ASSET_DIRS.has(segment) ||
        segment.endsWith(".egg-info") ||
        // Transient prepare-packaged-runtime state (staging dirs + lock) that
        // may exist beside packaging/ while another build is running.
        segment.startsWith(".runtime.prepare"),
    ) &&
    !leaf.startsWith(".coverage") &&
    !EXCLUDED_ASSET_EXTENSIONS.has(path.extname(leaf)) &&
    !GENERATED_PACKAGING_OUTPUTS.some(
      (output) =>
        relative === output || relative.startsWith(`${output}${path.sep}`),
    )
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

function removePathRecursive(targetPath) {
  const completed = spawnSync(
    "node",
    [cleanupHelperScript, path.relative(repoRoot, targetPath)],
    {
      cwd: repoRoot,
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

async function copyAssetWithRetry(packageDir, sourcePath, targetPath) {
  let lastError;
  for (let attempt = 1; attempt <= COPY_RETRY_ATTEMPTS; attempt++) {
    try {
      if (existsSync(targetPath)) {
        removePathRecursive(targetPath);
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

/**
 * Copies each asset path from `<packageDir>` into `<packageDir>/dist`
 * (stripping a leading `src/`), filtered through {@link shouldCopyAsset}.
 * Throws on a missing source asset — a build must fail loudly, not publish a
 * package with a silently absent asset.
 */
export async function copyPackageAssets(packageDirArg, assetPaths) {
  const packageDir = path.resolve(repoRoot, packageDirArg);
  const distDir = path.join(packageDir, "dist");
  for (const assetPath of assetPaths) {
    const sourcePath = path.join(packageDir, assetPath);
    if (!existsSync(sourcePath)) {
      throw new Error(`missing asset path: ${sourcePath}`);
    }

    const relativeTarget = assetPath.replace(/^src\//, "");
    const targetPath = path.join(distDir, relativeTarget);
    await copyAssetWithRetry(packageDir, sourcePath, targetPath);
  }
}

async function main() {
  const [packageDirArg, ...assetPaths] = process.argv.slice(2);
  if (!packageDirArg || assetPaths.length === 0) {
    console.error(
      "usage: node packages/scripts/copy-package-assets.mjs <package-dir> <src-path> [<src-path> ...]",
    );
    process.exit(1);
  }
  try {
    await copyPackageAssets(packageDirArg, assetPaths);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
