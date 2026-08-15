#!/usr/bin/env node
/**
 * Bounds the local turbo cache so it cannot grow without limit.
 *
 * Turbo's local cache is content-addressed (each task hash maps to a fixed set
 * of filenames), so lookups stay O(1) regardless of cache size — a large cache
 * does not slow builds. The only real costs of an unbounded cache are disk
 * space and orphaned fragments left behind by interrupted writes. This script
 * addresses both:
 *   1. Deletes orphaned `*.tmp` write fragments.
 *   2. Enforces a max total size by evicting the oldest complete entries
 *      (each entry = `<hash>.tar.zst` + `<hash>-meta.json` + `<hash>-manifest.json`)
 *      until the cache is under the cap.
 *
 * `--max-gb` must be a positive finite number that rounds to a positive,
 * safely representable whole-byte cap. Invalid overrides fail closed before
 * eviction so a typo cannot skip pruning or wipe the cache.
 *
 * Usage:
 *   node packages/scripts/prune-turbo-cache.mjs [--max-gb=20] [--dry-run]
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const DEFAULT_MAX_GB = 20;
const BYTES_PER_GB = 1024 ** 3;

/**
 * Parse a positive finite gigabyte cap for `--max-gb`.
 * @param {string} value
 * @param {string} [label]
 * @returns {number}
 */
export function parseMaxGb(value, label = "--max-gb") {
  const raw = String(value ?? "").trim();
  if (raw === "") {
    throw new Error(
      `${label} must be a positive finite number of gigabytes (received ${JSON.stringify(String(value ?? ""))})`,
    );
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `${label} must be a positive finite number of gigabytes (received ${JSON.stringify(String(value ?? ""))})`,
    );
  }
  return parsed;
}

/**
 * Convert a gigabyte cap to a nearest-whole-byte budget. A positive GB value
 * is not usable when it rounds below one byte or exceeds safe integer range.
 * @param {number} maxGb
 * @param {string} [label]
 * @returns {number}
 */
export function maxBytesFromGb(maxGb, label = "--max-gb") {
  const maxBytes = Math.round(maxGb * BYTES_PER_GB);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error(
      `${label} must convert to a positive safe-integer byte cap (received ${JSON.stringify(maxGb)})`,
    );
  }
  return maxBytes;
}

/**
 * Parse CLI argv into dry-run and max-size options.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const dryRun = argv.includes("--dry-run");
  const maxGbArg = argv.find((a) => a.startsWith("--max-gb="));
  let maxGb = DEFAULT_MAX_GB;
  if (maxGbArg !== undefined) {
    maxGb = parseMaxGb(maxGbArg.slice("--max-gb=".length), "--max-gb");
  }
  return {
    dryRun,
    maxGb,
    maxBytes: maxBytesFromGb(maxGb),
  };
}

/**
 * Resolve the turbo cache directory from env and cwd.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [cwd]
 */
export function resolveCacheDir(env = process.env, cwd = process.cwd()) {
  return path.resolve(cwd, env.TURBO_CACHE_DIR || ".turbo/cache");
}

/**
 * Prune orphaned tmp fragments and oldest entries until under the byte cap.
 * @param {{ cacheDir: string, maxBytes: number, dryRun?: boolean }} options
 */
export function pruneTurboCache(options) {
  const { cacheDir, maxBytes, dryRun = false } = options;
  if (!fs.existsSync(cacheDir)) {
    return {
      missing: true,
      cacheDir,
      totalSize: 0,
      tmpCount: 0,
      tmpFreed: 0,
      evictedCount: 0,
      evicted: 0,
      endSize: 0,
    };
  }

  const rm = (p) => {
    if (dryRun) return;
    fs.rmSync(p, { force: true });
  };

  const dirents = fs.readdirSync(cacheDir, { withFileTypes: true });

  // 1. Orphaned write fragments.
  let tmpFreed = 0;
  let tmpCount = 0;
  for (const d of dirents) {
    if (!d.isFile() || !d.name.endsWith(".tmp")) continue;
    const full = path.join(cacheDir, d.name);
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
      : name.slice(
          0,
          name.indexOf("-") === -1 ? name.length : name.indexOf("-"),
        );
    const full = path.join(cacheDir, name);
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

  return {
    missing: false,
    cacheDir,
    totalSize,
    tmpCount,
    tmpFreed,
    evictedCount,
    evicted,
    endSize: totalSize - evicted,
  };
}

function fmt(bytes) {
  return `${(bytes / BYTES_PER_GB).toFixed(2)} GB`;
}

function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    // error-policy:J1 CLI boundary — invalid --max-gb fails closed before prune
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[prune-turbo-cache] ${message}\n`);
    process.exit(2);
  }

  const cacheDir = resolveCacheDir(env);
  const result = pruneTurboCache({
    cacheDir,
    maxBytes: options.maxBytes,
    dryRun: options.dryRun,
  });

  if (result.missing) {
    console.log(`[prune-turbo-cache] No cache at ${cacheDir}; nothing to do.`);
    return;
  }

  console.log(
    `[prune-turbo-cache]${options.dryRun ? " (dry-run)" : ""} ` +
      `start=${fmt(result.totalSize + result.tmpFreed)} cap=${fmt(options.maxBytes)} | ` +
      `tmp: removed ${result.tmpCount} (${fmt(result.tmpFreed)}), ` +
      `evicted ${result.evictedCount} entr${result.evictedCount === 1 ? "y" : "ies"} (${fmt(result.evicted)}), ` +
      `end=${fmt(result.endSize)}`,
  );
}

const isDirectRun =
  import.meta.main === true ||
  (typeof process.argv[1] === "string" &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href);

if (isDirectRun) {
  main();
}
