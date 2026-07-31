#!/usr/bin/env node
// Drives repo automation flatten tsc package output with explicit CLI and CI behavior.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { findWorkspaceRoot } from "./lib/repo-root.mjs";

const execFileAsync = promisify(execFile);

const packageDirArg = process.argv[2];
if (!packageDirArg) {
  console.error(
    "Usage: node packages/scripts/flatten-tsc-package-output.mjs <package-dir>",
  );
  process.exit(1);
}

const root = findWorkspaceRoot(process.cwd());
const packageDir = path.resolve(root, packageDirArg);
const relPackageDir = path.relative(root, packageDir).split(path.sep).join("/");
const distDir = path.join(packageDir, "dist");
const nestedSourceDir = path.join(distDir, ...relPackageDir.split("/"), "src");
const cleanupHelper = path.join(
  root,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isTransientWindowsFsError(error) {
  return (
    error?.code === "EPERM" ||
    error?.code === "EBUSY" ||
    error?.code === "ENOTEMPTY"
  );
}

async function retryTransientFsOperation(operation) {
  const attempts = 5;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientWindowsFsError(error) || attempt === attempts - 1) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function removePathRecursive(targetPath) {
  await execFileAsync(process.execPath, [cleanupHelper, targetPath], {
    cwd: root,
  });
}

async function hasFlatEntryPoint() {
  return (
    (await pathExists(path.join(distDir, "index.js"))) ||
    (await pathExists(path.join(distDir, "index.d.ts")))
  );
}

// Move every file from srcDir into destDir, recursing into subdirectories and
// overwriting same-named files, WITHOUT deleting unrelated files already in
// destDir. Replacing the whole directory here destroyed sibling bundler
// output that shares a dist subdirectory with the tsc declarations — e.g.
// plugin-app-control's tsup-built dist/workers/app-worker-entry.js was wiped
// by the d.ts move, so the app worker could never spawn at runtime.
async function mergeInto(srcDir, destDir) {
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(srcDir, entry.name);
    const to = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      // A same-name FILE at the destination blocks the recursive mkdir —
      // clear it first, mirroring the non-directory branch.
      const destStat = await fs.stat(to).catch(() => null);
      if (destStat && !destStat.isDirectory()) {
        await removePathRecursive(to);
      }
      await mergeInto(from, to);
    } else {
      await removePathRecursive(to);
      await retryTransientFsOperation(() => fs.rename(from, to));
    }
  }
  await fs.rmdir(srcDir).catch(() => {});
}

async function flattenNestedSource() {
  const entries = await fs.readdir(nestedSourceDir);
  for (const entry of entries) {
    const nestedEntry = path.join(nestedSourceDir, entry);
    if (!(await pathExists(nestedEntry))) {
      continue;
    }
    const targetEntry = path.join(distDir, entry);
    const stagingEntry = path.join(
      distDir,
      `.flatten-${process.pid}-${Date.now()}-${entry}`,
    );

    try {
      await retryTransientFsOperation(() =>
        fs.rename(nestedEntry, stagingEntry),
      );
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }

    const [stagingStat, targetStat] = await Promise.all([
      fs.stat(stagingEntry).catch(() => null),
      fs.stat(targetEntry).catch(() => null),
    ]);
    if (stagingStat?.isDirectory() && targetStat?.isDirectory()) {
      await mergeInto(stagingEntry, targetEntry);
      continue;
    }
    await removePathRecursive(targetEntry);
    await retryTransientFsOperation(() => fs.rename(stagingEntry, targetEntry));
  }
}

async function removeNestedRoots() {
  await removePathRecursive(path.join(distDir, "packages"));
  await removePathRecursive(path.join(distDir, "plugins"));
}

let flattened = false;
for (let attempt = 0; attempt < 20; attempt += 1) {
  if (!(await pathExists(nestedSourceDir))) {
    if (flattened || (await hasFlatEntryPoint())) {
      process.exit(0);
    }
    console.error(`Compiled source directory not found: ${nestedSourceDir}`);
    process.exit(1);
  }

  await flattenNestedSource();
  flattened = true;
  await removeNestedRoots();

  if (!(await pathExists(nestedSourceDir))) {
    process.exit(0);
  }

  await delay(100 * (attempt + 1));
}

console.error(`Compiled source directory kept reappearing: ${nestedSourceDir}`);
process.exit(1);
