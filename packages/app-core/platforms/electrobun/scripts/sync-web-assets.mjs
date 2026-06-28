#!/usr/bin/env node
/**
 * Sync the host app's Vite `dist/` into the canonical Electrobun shell at
 * `packages/app-core/platforms/electrobun/app/` (not under the host app).
 *
 * Usage:
 *   node packages/app-core/platforms/electrobun/scripts/sync-web-assets.mjs
 *
 * Resolves the host app via the standard elizaOS layout; run after
 * `bun run build:web` (or equivalent).
 */
import { spawnSync } from "node:child_process";
import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  resolveElectrobunDir,
  resolveMainAppDir,
} from "../../../scripts/lib/app-dir.mjs";
import { resolveRepoRootFromImportMeta } from "../../../scripts/lib/repo-root.mjs";

const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);
const appRoot = resolveMainAppDir(repoRoot, "app");
const electrobunRoot = resolveElectrobunDir(repoRoot);
const sourceDir = path.join(appRoot, "dist");
const targetDir = path.join(electrobunRoot, "app");
const rmPathRecursiveScript = path.join(
  repoRoot,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);
const LOG_PREFIX = "[Electrobun]";

async function ensureDirExists(dir) {
  try {
    const info = await stat(dir);
    return info.isDirectory();
  } catch {
    return false;
  }
}

function rmRecursive(pathToRemove) {
  const result = spawnSync(
    process.execPath,
    [rmPathRecursiveScript, path.resolve(pathToRemove)],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    const reason =
      result.stderr?.trim() ||
      result.stdout?.trim() ||
      result.error?.message ||
      `exit status ${String(result.status)}`;
    throw new Error(
      `${LOG_PREFIX} failed to recursively remove ${pathToRemove}: ${reason}`,
    );
  }
}

if (!(await ensureDirExists(sourceDir))) {
  console.error(`${LOG_PREFIX} Web build output not found: ${sourceDir}`);
  console.error(
    `${LOG_PREFIX} Run \`bun run build\` from the host app before syncing Electrobun assets.`,
  );
  process.exit(1);
}

rmRecursive(targetDir);
await mkdir(targetDir, { recursive: true });
await cp(sourceDir, targetDir, { recursive: true, force: true });

console.info(`${LOG_PREFIX} Synced web assets: ${sourceDir} -> ${targetDir}`);
