/**
 * Shared utilities for the view-bundle-size gate (#10724).
 *
 * Pure Node ESM (built-ins only) — the whole harness runs with plain `node`, no
 * build step and no `@elizaos/*` imports. Measures the on-disk view bundles the
 * existing view-bundle vite build emits (`plugins/<name>/dist/views/*.js|css`),
 * records timestamped JSON results, and captures git context — the same shape
 * the `memperf` / `loadperf` harnesses use.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export const HERE = dirname(fileURLToPath(import.meta.url));
/** eliza repo root (…/packages/benchmarks/view-bundle-size -> …) */
export const REPO_ROOT = join(HERE, "..", "..", "..");
export const RESULTS_ROOT = join(HERE, "results");
export const PLUGINS_DIR = join(REPO_ROOT, "plugins");

/**
 * Gzip compression level used for every measurement AND for the committed
 * baseline in `budgets.json`. Pinned so the number is deterministic run-to-run
 * (same input + same level => same gzip byte count); ratcheting budgets stays
 * apples-to-apples.
 */
export const GZIP_LEVEL = 9;

/** kB with one decimal, or an em dash for null (never render null as "0 kB"). */
export function kb(n) {
  return n == null ? "—" : `${(n / 1024).toFixed(1)} kB`;
}

/** Gzipped byte length of a buffer at the pinned level. */
export function gzipBytesOf(buf) {
  return gzipSync(buf, { level: GZIP_LEVEL }).length;
}

/** Plugin directory names that declare a view bundle (have vite.config.views.ts), sorted. */
export function listViewBundlePlugins() {
  if (!existsSync(PLUGINS_DIR)) return [];
  return readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => existsSync(join(PLUGINS_DIR, n, "vite.config.views.ts")))
    .sort();
}

/**
 * Measure one plugin's built view bundle: sum the raw + gzip bytes of every
 * emitted `.js` / `.css` file under `dist/views` (sourcemaps excluded — they do
 * not ship). Returns `{ built: false }` when the dir is absent or holds no
 * JS/CSS (the build produced no bundle), so the caller records an honest
 * did-not-build row rather than a fake `0`.
 *
 * A file vanishing mid-scan (ENOENT — e.g. a concurrent rebuild) marks the
 * whole bundle not-built rather than reporting a partial, misleading size.
 */
export function measureViewBundle(plugin) {
  const dir = join(PLUGINS_DIR, plugin, "dist", "views");
  if (!existsSync(dir)) {
    return { built: false, rawBytes: 0, gzipBytes: 0, files: [] };
  }
  const files = readdirSync(dir)
    .filter(
      (f) => (f.endsWith(".js") || f.endsWith(".css")) && !f.endsWith(".map"),
    )
    .sort();
  if (files.length === 0) {
    return { built: false, rawBytes: 0, gzipBytes: 0, files: [] };
  }
  let rawBytes = 0;
  let gzipBytes = 0;
  for (const f of files) {
    let buf;
    try {
      buf = readFileSync(join(dir, f));
    } catch (err) {
      if (err?.code === "ENOENT") {
        return { built: false, rawBytes: 0, gzipBytes: 0, files: [] };
      }
      throw err;
    }
    rawBytes += buf.length;
    gzipBytes += gzipBytesOf(buf);
  }
  return { built: true, rawBytes, gzipBytes, files };
}

export function gitInfo() {
  const run = (args) => {
    try {
      return execFileSync("git", args, {
        cwd: REPO_ROOT,
        encoding: "utf8",
      }).trim();
    } catch {
      return null;
    }
  };
  return {
    branch: run(["rev-parse", "--abbrev-ref", "HEAD"]),
    commit: run(["rev-parse", "--short", "HEAD"]),
    dirty: !!run(["status", "--porcelain"]),
  };
}

/**
 * Persist a result as timestamped JSON under results/<kpi>/ and update
 * results/<kpi>/latest.json. `nowIso` is supplied by the caller to keep this
 * module clock-free.
 */
export function recordResult(kpi, payload, nowIso) {
  const dir = join(RESULTS_ROOT, kpi);
  mkdirSync(dir, { recursive: true });
  const stamp = nowIso.replace(/[:.]/g, "-");
  const record = { kpi, recordedAt: nowIso, git: gitInfo(), ...payload };
  const file = join(dir, `${stamp}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));
  writeFileSync(join(dir, "latest.json"), JSON.stringify(record, null, 2));
  return { file, record };
}

export function readLatest(kpi) {
  const f = join(RESULTS_ROOT, kpi, "latest.json");
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

export function loadBudgets() {
  return JSON.parse(readFileSync(join(HERE, "budgets.json"), "utf8"));
}

export { basename, existsSync, join, mkdirSync, readFileSync, writeFileSync };
