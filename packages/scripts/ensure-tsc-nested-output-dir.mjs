#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const packageDirArg = process.argv[2];
if (!packageDirArg) {
  console.error(
    "Usage: node packages/scripts/ensure-tsc-nested-output-dir.mjs <package-dir>",
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
const relPackageDir = path.relative(root, packageDir);

if (relPackageDir.startsWith("..") || path.isAbsolute(relPackageDir)) {
  console.error(`${packageDirArg} is outside the workspace root`);
  process.exit(1);
}

await fs.mkdir(path.join(packageDir, "dist", relPackageDir, "src"), {
  recursive: true,
});
