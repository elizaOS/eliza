#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const packageDirArg = process.argv[2];
if (!packageDirArg) {
  console.error(
    "Usage: node packages/scripts/flatten-tsc-package-output.mjs <package-dir>",
  );
  process.exit(1);
}

async function findWorkspaceRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    try {
      const raw = await fs.readFile(path.join(current, "package.json"), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.workspaces) return current;
    } catch {
      // keep walking
    }
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

const root = await findWorkspaceRoot(process.cwd());
const packageDir = path.resolve(root, packageDirArg);
const relPackageDir = path.relative(root, packageDir).split(path.sep).join("/");
const distDir = path.join(packageDir, "dist");
const nestedSourceDir = path.join(distDir, ...relPackageDir.split("/"), "src");

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

if (!(await pathExists(nestedSourceDir))) {
  if (
    (await pathExists(path.join(distDir, "index.js"))) ||
    (await pathExists(path.join(distDir, "index.d.ts")))
  ) {
    process.exit(0);
  }
  console.error(`Compiled source directory not found: ${nestedSourceDir}`);
  process.exit(1);
}

const entries = await fs.readdir(nestedSourceDir);
for (const entry of entries) {
  const nestedEntry = path.join(nestedSourceDir, entry);
  if (!(await pathExists(nestedEntry))) {
    continue;
  }
  const targetEntry = path.join(distDir, entry);
  await retryTransientFsOperation(() =>
    fs.rm(targetEntry, { recursive: true, force: true }),
  );
  try {
    await retryTransientFsOperation(() => fs.rename(nestedEntry, targetEntry));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

await retryTransientFsOperation(() =>
  fs.rm(path.join(distDir, "packages"), { recursive: true, force: true }),
);
await retryTransientFsOperation(() =>
  fs.rm(path.join(distDir, "plugins"), { recursive: true, force: true }),
);
