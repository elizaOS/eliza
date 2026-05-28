#!/usr/bin/env node
// Bounds the local turbo cache so it cannot grow without limit.
//
// Turbo's local cache is content-addressed (each task hash maps to a fixed set
// of filenames), so lookups stay O(1) regardless of cache size — a large cache
// does not slow builds. The only real costs of an unbounded cache are disk
// space and orphaned temp files left behind by interrupted writes. This script
// addresses both:
//   1. Deletes orphaned `*.tmp` write fragments.
//   2. Enforces a max total size by evicting the oldest complete entries
//      (each entry = `<hash>.tar.zst` + `<hash>-meta.json` + `<hash>-manifest.json`)
//      until the cache is under the cap.
//
// Usage:
//   node packages/scripts/prune-turbo-cache.mjs [--max-gb=20] [--dry-run]

import fs from "node:fs";
import path from "node:path";

const CACHE_DIR = path.resolve(
  process.cwd(),
  process.env.TURBO_CACHE_DIR || ".turbo/cache",
);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const maxGbArg = args.find((a) => a.startsWith("--max-gb="));
const maxBytes = Math.round(
  (maxGbArg ? Number(maxGbArg.split("=")[1]) : 20) * 1024 ** 3,
);

if (!fs.existsSync(CACHE_DIR)) {
  console.log(`[prune-turbo-cache] No cache at ${CACHE_DIR}; nothing to do.`);
  process.exit(0);
}

const fmt = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;
const rm = (p) => {
  if (dryRun) return;
  fs.rmSync(p, { force: true });
};

const dirents = fs.readdirSync(CACHE_DIR, { withFileTypes: true });

// 1. Orphaned temp fragments.
let tmpFreed = 0;
let tmpCount = 0;
for (const d of dirents) {
  if (!d.isFile() || !d.name.endsWith(".tmp")) continue;
  const full = path.join(CACHE_DIR, d.name);
  tmpFreed += fs.statSync(full).size;
  tmpCount += 1;
  rm(full);
}

// 2. Group remaining files into entries keyed by hash, tracking newest mtime
// and total size per entry. A hash is the leading filename segment before the
// first `.` (tarball) or `-` (meta/manifest).
const entries = new Map();
let totalSize = 0;
for (const d of dirents) {
  if (!d.isFile() || d.name.endsWith(".tmp")) continue;
  const name = d.name;
  const hash = name.includes(".")
    ? name.slice(0, name.indexOf("."))
    : name.slice(0, name.indexOf("-") === -1 ? name.length : name.indexOf("-"));
  const full = path.join(CACHE_DIR, name);
  const st = fs.statSync(full);
  totalSize += st.size;
  const entry = entries.get(hash) ?? { hash, files: [], size: 0, mtime: 0 };
  entry.files.push(full);
  entry.size += st.size;
  entry.mtime = Math.max(entry.mtime, st.mtimeMs);
  entries.set(hash, entry);
}

let evicted = 0;
let evictedCount = 0;
if (totalSize > maxBytes) {
  const oldestFirst = [...entries.values()].sort((a, b) => a.mtime - b.mtime);
  let running = totalSize;
  for (const entry of oldestFirst) {
    if (running <= maxBytes) break;
    for (const f of entry.files) rm(f);
    running -= entry.size;
    evicted += entry.size;
    evictedCount += 1;
  }
}

console.log(
  `[prune-turbo-cache]${dryRun ? " (dry-run)" : ""} ` +
    `start=${fmt(totalSize + tmpFreed)} cap=${fmt(maxBytes)} | ` +
    `tmp: removed ${tmpCount} (${fmt(tmpFreed)}), ` +
    `evicted ${evictedCount} entr${evictedCount === 1 ? "y" : "ies"} (${fmt(evicted)}), ` +
    `end=${fmt(totalSize - evicted)}`,
);
