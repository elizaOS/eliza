#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const packageDirArg = process.argv[2];
if (!packageDirArg) {
  console.error("Usage: node scripts/flatten-tsc-package-output.mjs <package-dir>");
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

if (!(await pathExists(nestedSourceDir))) {
  console.error(`Compiled source directory not found: ${nestedSourceDir}`);
  process.exit(1);
}

const entries = await fs.readdir(nestedSourceDir);
for (const entry of entries) {
  await fs.rm(path.join(distDir, entry), { recursive: true, force: true });
  await fs.rename(path.join(nestedSourceDir, entry), path.join(distDir, entry));
}

await fs.rm(path.join(distDir, "packages"), { recursive: true, force: true });
await fs.rm(path.join(distDir, "plugins"), { recursive: true, force: true });
