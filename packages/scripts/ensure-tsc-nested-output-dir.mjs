#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { findWorkspaceRoot } from "./lib/repo-root.mjs";

const packageDirArg = process.argv[2];
if (!packageDirArg) {
  console.error(
    "Usage: node packages/scripts/ensure-tsc-nested-output-dir.mjs <package-dir>",
  );
  process.exit(1);
}

const root = findWorkspaceRoot(process.cwd());
const packageDir = path.resolve(root, packageDirArg);
const relPackageDir = path.relative(root, packageDir);

if (relPackageDir.startsWith("..") || path.isAbsolute(relPackageDir)) {
  console.error(`${packageDirArg} is outside the workspace root`);
  process.exit(1);
}

async function removeGeneratedSourceDeclarations(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["dist", "node_modules"].includes(entry.name)) {
          return;
        }
        await removeGeneratedSourceDeclarations(entryPath);
        return;
      }

      if (!entry.isFile() || !entry.name.endsWith(".d.ts")) {
        return;
      }

      const sourceBase = entryPath.slice(0, -".d.ts".length);
      const hasSourceSibling =
        (await pathExists(`${sourceBase}.ts`)) ||
        (await pathExists(`${sourceBase}.tsx`));
      if (!hasSourceSibling) {
        return;
      }

      await fs.rm(entryPath, { force: true });
      await fs.rm(`${entryPath}.map`, { force: true });
    }),
  );
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

await removeGeneratedSourceDeclarations(path.join(packageDir, "src"));
await fs.mkdir(path.join(packageDir, "dist", relPackageDir, "src"), {
  recursive: true,
});
