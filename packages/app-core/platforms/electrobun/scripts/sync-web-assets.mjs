#!/usr/bin/env node
/**
 * Sync the host app's Vite `dist/` output into the Electrobun shell at
 * `<appDir>/electrobun/app/` so the desktop bundle picks up the latest web
 * assets.
 *
 * Usage (from the consumer repo root):
 *   node eliza/packages/app-core/platforms/electrobun/scripts/sync-web-assets.mjs
 *
 * Resolves the host app via the standard elizaOS layout, runs after
 * `bun run build:web` (or equivalent), and replaces the previous bundle
 * atomically.
 */
import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { resolveMainAppDir } from "../../../scripts/lib/app-dir.mjs";
import { resolveRepoRootFromImportMeta } from "../../../scripts/lib/repo-root.mjs";

const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);
const appRoot = resolveMainAppDir(repoRoot, "app");
const sourceDir = path.join(appRoot, "dist");
const targetDir = path.join(appRoot, "electrobun", "app");
const LOG_PREFIX = "[Electrobun]";

async function ensureDirExists(dir) {
  try {
    const info = await stat(dir);
    return info.isDirectory();
  } catch {
    return false;
  }
}

if (!(await ensureDirExists(sourceDir))) {
  console.error(`${LOG_PREFIX} Web build output not found: ${sourceDir}`);
  console.error(
    `${LOG_PREFIX} Run \`bun run build\` from the host app before syncing Electrobun assets.`,
  );
  process.exit(1);
}

await rm(targetDir, { recursive: true, force: true });
await mkdir(targetDir, { recursive: true });
await cp(sourceDir, targetDir, { recursive: true, force: true });

console.info(`${LOG_PREFIX} Synced web assets: ${sourceDir} -> ${targetDir}`);
