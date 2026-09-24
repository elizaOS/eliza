/**
 * Generic source-vs-artifact staleness check (issue #9309).
 *
 * Several on-device build inputs are cached and reused across builds (the iOS
 * llama.cpp MTP slice, the iOS agent bundle, desktop runtime packages). Each had
 * a presence-only reuse gate that could silently reuse a STALE artifact after
 * its sources changed. This module turns "reuse when present" into "reuse only
 * when the artifact is newer than every source it was built from", so a changed
 * input forces a rebuild instead of shipping old code.
 *
 * mtime is the right granularity here: these artifacts are heavy native/bundle
 * builds keyed off large source trees, and the build host writes both, so an
 * artifact older than any source file is unambiguously stale.
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT_EXCLUDE = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".turbo",
  "out",
]);

/**
 * Largest mtime (ms) of any file under `dir`, skipping build/dep dirs.
 * @param {string} dir
 * @param {{ exclude?: Set<string>, exts?: Set<string>|null, maxDepth?: number }} [opts]
 */
export function maxMtimeUnder(
  dir,
  { exclude = DEFAULT_EXCLUDE, exts = null, maxDepth = 25 } = {},
) {
  let max = 0;
  const walk = (current, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (exclude.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (exts && !exts.has(path.extname(entry.name))) continue;
      try {
        max = Math.max(max, fs.statSync(full).mtimeMs);
      } catch {
        /* ignore unreadable entries */
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir, 0);
  return max;
}

/** mtime (ms) of a single file, or 0 if missing/unreadable. */
export function fileMtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Is `artifactPath` stale relative to its source dirs/files?
 *
 * @param {string} artifactPath the built artifact (or its marker file)
 * @param {{ sourceDirs?: string[], sourceFiles?: string[], exts?: Set<string>|null }} [opts]
 * @returns {{ stale: boolean, reason: string, artifactMtime: number,
 *             newestSourceMtime: number, newestSource: string|null }}
 */
export function artifactStaleness(
  artifactPath,
  { sourceDirs = [], sourceFiles = [], exts = null } = {},
) {
  const artifactMtime = fileMtime(artifactPath);
  if (!artifactMtime) {
    return {
      stale: true,
      reason: `artifact missing: ${artifactPath}`,
      artifactMtime: 0,
      newestSourceMtime: 0,
      newestSource: null,
    };
  }
  let newestSourceMtime = 0;
  let newestSource = null;
  const consider = (mtime, label) => {
    if (mtime > newestSourceMtime) {
      newestSourceMtime = mtime;
      newestSource = label;
    }
  };
  for (const dir of sourceDirs) consider(maxMtimeUnder(dir, { exts }), dir);
  for (const file of sourceFiles) consider(fileMtime(file), file);

  if (newestSourceMtime > artifactMtime) {
    return {
      stale: true,
      reason: `source newer than artifact (${newestSource})`,
      artifactMtime,
      newestSourceMtime,
      newestSource,
    };
  }
  return {
    stale: false,
    reason: "fresh",
    artifactMtime,
    newestSourceMtime,
    newestSource,
  };
}
