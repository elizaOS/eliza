#!/usr/bin/env node
/**
 * Sync the canonical @elizaos/ui/brand assets into a consumer's public/
 * directory. Run by each consumer's `prebuild` and `predev` hooks so the
 * brand files are always fresh in the served static tree.
 *
 * Usage:
 *   node packages/ui/scripts/sync-to-public.ts <consumer-public-dir> [flags]
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
 * except for `background/` and `clouds/`, which are replaced after staging
 * succeeds to drop orphan files.
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removePathRecursive } from "../../scripts/rm-path-recursive.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_ROOT = resolve(__dirname, "..", "assets");
function copyDir(src: string, dest: string): void {
  cpSync(src, dest, { recursive: true });
}

async function copyDirClean(
  src: string,
  dest: string,
  shouldCopy: (entry: string, source: string) => boolean = () => true,
): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  const staging = mkdtempSync(join(dirname(dest), ".ui-assets-"));
  const next = join(staging, "next");
  const previous = join(staging, "previous");
  try {
    cpSync(src, next, {
      recursive: true,
      filter: (source) =>
        statSync(source).isDirectory() || shouldCopy(basename(source), source),
    });
    const hadPrevious = existsSync(dest);
    if (hadPrevious) renameSync(dest, previous);
    try {
      renameSync(next, dest);
    } catch (error) {
      if (hadPrevious) renameSync(previous, dest);
      throw error;
    }
  } finally {
    await removePathRecursive(staging);
  }
}

const args = process.argv.slice(2);
const cloudsArg = args.find(
  (a) => a === "--clouds" || a.startsWith("--clouds="),
);
const includeClouds = Boolean(cloudsArg);
const includeBackgroundVideos = args.includes("--background-videos");
const selectedCloudSpeeds = cloudsArg?.includes("=")
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
    "usage: sync-to-public.ts <consumer-public-dir> [--logos] [--favicons] [--ogembeds] [--banners] [--concepts] [--background] [--clouds[=speeds]]",
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
const allowedFlags = new Set([
  ...categoryFlags,
  "--clouds",
  "--background-videos",
]);
for (const flag of flags) {
  if (!allowedFlags.has(flag))
    throw new Error(`Unknown asset sync flag: ${flag}`);
}
if (positional.length !== 1)
  throw new Error("Expected exactly one public directory");
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
  // The favicon and orange-background logo use identical SVG bytes.
  copyFileSync(
    join(ASSETS_ROOT, "logos", "logo_white_orangebg.svg"),
    join(resolvedTarget, "brand", "favicons", "favicon.svg"),
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
  await copyDirClean(
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
    await copyDirClean(cloudsSrc, join(resolvedTarget, "clouds"), (entry) => {
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
  `[ui-brand] synced into ${resolvedTarget}: ${synced.join(", ") || "(nothing)"}`,
);
