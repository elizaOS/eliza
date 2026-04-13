import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
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

for (const assetPath of assetPaths) {
  const sourcePath = path.join(packageDir, assetPath);
  if (!existsSync(sourcePath)) {
    console.error(`missing asset path: ${sourcePath}`);
    process.exit(1);
  }

  const relativeTarget = assetPath.replace(/^src\//, "");
  const targetPath = path.join(distDir, relativeTarget);
  mkdirSync(path.dirname(targetPath), { recursive: true });
  cpSync(sourcePath, targetPath, { recursive: true });
}
