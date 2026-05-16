#!/usr/bin/env node
/**
 * Sync the canonical @elizaos/shared-brand assets into a consumer's public/
 * directory. Run by each consumer's `prebuild` and `predev` hooks so the
 * brand files are always fresh in the served static tree.
 *
 * Usage:
 *   node packages/shared-brand/scripts/sync-to-public.mjs <consumer-public-dir>
 *
 * The target directory is created if missing. Existing files are overwritten.
 * Files NOT present in `assets/` are left alone (the script only adds/updates).
 */

import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_ROOT = resolve(__dirname, "..", "assets");

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

const target = process.argv[2];
if (!target) {
  console.error("usage: sync-to-public.mjs <consumer-public-dir>");
  process.exit(1);
}

const resolvedTarget = resolve(target);
copyDir(join(ASSETS_ROOT, "logos"), join(resolvedTarget, "brand", "logos"));
copyDir(
  join(ASSETS_ROOT, "concepts"),
  join(resolvedTarget, "brand", "concepts"),
);
copyDir(
  join(ASSETS_ROOT, "background"),
  join(resolvedTarget, "brand", "background"),
);
copyDir(
  join(ASSETS_ROOT, "favicons"),
  join(resolvedTarget, "brand", "favicons"),
);
copyDir(join(ASSETS_ROOT, "clouds"), join(resolvedTarget, "clouds"));
console.log(`[shared-brand] synced into ${resolvedTarget}`);
