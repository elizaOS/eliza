#!/usr/bin/env node
/**
 * Sync the canonical @elizaos/shared-brand assets into a consumer's public/
 * directory. Run by each consumer's `prebuild` and `predev` hooks so the
 * brand files are always fresh in the served static tree.
 *
 * Usage:
 *   node packages/shared-brand/scripts/sync-to-public.mjs <consumer-public-dir> [--clouds]
 *
 * The target directory is created if missing. Existing files are overwritten.
 * Files NOT present in `assets/` are left alone (the script only adds/updates).
 *
 * The `clouds/` tree (~17MB) is heavy and only needed by consumers that render
 * a <video> from it. Pass `--clouds` to include it; otherwise it is skipped.
 */

import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
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

function copyDirClean(src, dest, shouldCopy = () => true) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      copyDirClean(srcPath, destPath, shouldCopy);
    } else if (shouldCopy(entry, srcPath)) {
      copyFileSync(srcPath, destPath);
    }
  }
}

const args = process.argv.slice(2);
const cloudsArg = args.find((a) => a === "--clouds" || a.startsWith("--clouds="));
const includeClouds = Boolean(cloudsArg);
const includeBackgroundVideos = args.includes("--background-videos");
const selectedCloudSpeeds =
  cloudsArg && cloudsArg.includes("=")
    ? new Set(
        cloudsArg
          .split("=")[1]
          .split(",")
          .map((speed) => speed.trim())
          .filter(Boolean),
      )
    : null;
const positional = args.filter((a) => !a.startsWith("--"));
const target = positional[0];
if (!target) {
  console.error("usage: sync-to-public.mjs <consumer-public-dir> [--clouds]");
  process.exit(1);
}

const resolvedTarget = resolve(target);
copyDir(join(ASSETS_ROOT, "logos"), join(resolvedTarget, "brand", "logos"));
copyDir(join(ASSETS_ROOT, "banners"), join(resolvedTarget, "brand", "banners"));
copyDir(
  join(ASSETS_ROOT, "ogembeds"),
  join(resolvedTarget, "brand", "ogembeds"),
);
copyDir(
  join(ASSETS_ROOT, "concepts"),
  join(resolvedTarget, "brand", "concepts"),
);
copyDirClean(
  join(ASSETS_ROOT, "background"),
  join(resolvedTarget, "brand", "background"),
  (entry) => includeBackgroundVideos || !entry.endsWith(".mp4"),
);
copyDir(
  join(ASSETS_ROOT, "favicons"),
  join(resolvedTarget, "brand", "favicons"),
);
if (includeClouds) {
  copyDirClean(
    join(ASSETS_ROOT, "clouds"),
    join(resolvedTarget, "clouds"),
    (entry) => {
      if (entry.startsWith("poster-")) {
        return /^poster-(?:640|960)\.jpg$/.test(entry);
      }
      if (!selectedCloudSpeeds) return true;
      if (!entry.startsWith("clouds_")) return true;
      return [...selectedCloudSpeeds].some((speed) =>
        entry.startsWith(`clouds_${speed}_`),
      );
    },
  );
}
console.log(
  `[shared-brand] synced into ${resolvedTarget}${includeClouds ? ` (with clouds${selectedCloudSpeeds ? `: ${[...selectedCloudSpeeds].join(",")}` : ""})` : ""}`,
);
