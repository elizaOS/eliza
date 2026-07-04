#!/usr/bin/env node
// Drives repo automation remove source build artifacts with explicit CLI and CI behavior.
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { positionals } = parseArgs({
  allowPositionals: true,
});

if (positionals.length !== 1) {
  console.error(
    "Usage: node packages/scripts/remove-source-build-artifacts.mjs <src-dir>",
  );
  process.exit(1);
}

const root = process.cwd();
const srcDir = path.resolve(root, positionals[0]);
if (!srcDir.startsWith(`${root}${path.sep}`)) {
  throw new Error(`Refusing to clean outside the workspace: ${srcDir}`);
}

function isBuildArtifact(filePath) {
  return (
    filePath.endsWith(".js") ||
    filePath.endsWith(".js.map") ||
    filePath.endsWith(".d.ts") ||
    filePath.endsWith(".d.ts.map")
  );
}

async function cleanDirectory(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await cleanDirectory(fullPath);
        return;
      }
      if (entry.isFile() && isBuildArtifact(fullPath)) {
        await rm(fullPath, { force: true });
      }
    }),
  );
}

// Stale ignored build output beside TypeScript sources can win module
// resolution over the real .ts files; clean it before bundlers inspect src/.
await cleanDirectory(srcDir);
