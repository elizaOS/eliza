#!/usr/bin/env node
/**
 * Sync the canonical @elizaos/shared/brand assets into a consumer's public/
 * directory. Run by each consumer's `prebuild` and `predev` hooks so the
 * brand files are always fresh in the served static tree.
 *
 * Usage:
 *   node packages/shared/scripts/sync-to-public.mjs <consumer-public-dir> [flags]
 *
 * Per-category flags (each consumer opts in only to what its source references):
 *   --logos             (default) sync brand/logos/
 *   --favicons          (default) sync brand/favicons/
 *   --ogembeds          sync brand/ogembeds/
 *   --banners           sync brand/banners/
 *   --concepts          sync brand/concepts/
 *   --background        sync brand/background/ (excludes .mp4 unless --background-videos)
 *   --background-videos include .mp4 files in background/
 *   --clouds[=speeds]   sync clouds/ at repo root (speeds optional, e.g. --clouds=4x,8x)
 *
 * Default (no flags except positional target): --logos --favicons only.
 *
 * The target directory is created if missing. Existing files are overwritten;
 * files NOT present in `assets/` are left alone (the script only adds/updates),
 * except for `background/` and `clouds/` which are cleaned before sync to drop
 * orphan files.
 */

import {
  copyFileSync,
  existsSync,
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
const cloudsArg = args.find(
  (a) => a === "--clouds" || a.startsWith("--clouds="),
);
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
  console.error(
    "usage: sync-to-public.mjs <consumer-public-dir> [--logos] [--favicons] [--ogembeds] [--banners] [--concepts] [--background] [--clouds[=speeds]]",
  );
  process.exit(1);
}

const flags = new Set(
  args.filter((a) => a.startsWith("--")).map((a) => a.split("=")[0]),
);
// Default: logos + favicons when no category flags are passed.
const categoryFlags = [
  "--logos",
  "--favicons",
  "--ogembeds",
  "--banners",
  "--concepts",
  "--background",
];
const noCategorySpecified = !categoryFlags.some((f) => flags.has(f));
const include = {
  logos: noCategorySpecified || flags.has("--logos"),
  favicons: noCategorySpecified || flags.has("--favicons"),
  ogembeds: flags.has("--ogembeds"),
  banners: flags.has("--banners"),
  concepts: flags.has("--concepts"),
  background: flags.has("--background"),
};

const resolvedTarget = resolve(target);
const synced = [];

if (include.logos) {
  copyDir(join(ASSETS_ROOT, "logos"), join(resolvedTarget, "brand", "logos"));
  synced.push("logos");
}
if (include.favicons) {
  copyDir(
    join(ASSETS_ROOT, "favicons"),
    join(resolvedTarget, "brand", "favicons"),
  );
  synced.push("favicons");
}
if (include.ogembeds) {
  copyDir(
    join(ASSETS_ROOT, "ogembeds"),
    join(resolvedTarget, "brand", "ogembeds"),
  );
  synced.push("ogembeds");
}
if (include.banners) {
  copyDir(
    join(ASSETS_ROOT, "banners"),
    join(resolvedTarget, "brand", "banners"),
  );
  synced.push("banners");
}
if (include.concepts) {
  copyDir(
    join(ASSETS_ROOT, "concepts"),
    join(resolvedTarget, "brand", "concepts"),
  );
  synced.push("concepts");
}
if (include.background) {
  copyDirClean(
    join(ASSETS_ROOT, "background"),
    join(resolvedTarget, "brand", "background"),
    (entry) => includeBackgroundVideos || !entry.endsWith(".mp4"),
  );
  synced.push(includeBackgroundVideos ? "background+videos" : "background");
}
if (includeClouds) {
  // Asset trees that are not part of the git checkout (e.g. the optional
  // `clouds/` directory on a fresh sparse checkout) must not hard-fail the
  // consumer's prebuild. Skip with a synced-list breadcrumb instead so the
  // caller's log makes the absence obvious.
  const cloudsSrc = join(ASSETS_ROOT, "clouds");
  if (existsSync(cloudsSrc)) {
    copyDirClean(cloudsSrc, join(resolvedTarget, "clouds"), (entry) => {
      if (entry.startsWith("poster-")) {
        return /^poster-(?:640|960)\.jpg$/.test(entry);
      }
      if (!selectedCloudSpeeds) return true;
      if (!entry.startsWith("clouds_")) return true;
      return [...selectedCloudSpeeds].some((speed) =>
        entry.startsWith(`clouds_${speed}_`),
      );
    });
    synced.push(
      selectedCloudSpeeds
        ? `clouds(${[...selectedCloudSpeeds].join(",")})`
        : "clouds",
    );
  } else {
    synced.push("clouds(skipped:missing-source)");
  }
}

console.log(
  `[shared-brand] synced into ${resolvedTarget}: ${synced.join(", ") || "(nothing)"}`,
);
