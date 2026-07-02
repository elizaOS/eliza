/**
 * Shared utilities for the load/perf KPI harness.
 *
 * Pure Node ESM (built-ins only) so the suite runs with `node packages/benchmarks/loadperf/<kpi>.mjs`
 * without any build/install step. Optional deps (playwright, ws) are imported lazily by the KPIs
 * that need them and degrade to a clearly-marked `skipped` result when unavailable.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  brotliCompressSync,
  gzipSync,
  constants as zlibConstants,
} from "node:zlib";

export const HERE = dirname(fileURLToPath(import.meta.url));
/** eliza repo root (…/packages/benchmarks/loadperf -> …) */
export const REPO_ROOT = join(HERE, "..", "..", "..");
export const APP_DIST = join(REPO_ROOT, "packages", "app", "dist");
export const RESULTS_ROOT = join(HERE, "results");

// ---------------------------------------------------------------------------
// Size helpers
// ---------------------------------------------------------------------------

/** Brotli-compressed size in bytes (text quality 11 — matches what a CDN serves). */
export function brotliSize(buf) {
  return brotliCompressSync(buf, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  }).length;
}

/** Gzip-compressed size in bytes (level 9). */
export function gzipSize(buf) {
  return gzipSync(buf, { level: 9 }).length;
}

/** Recursively list files under `dir`, returning absolute paths. */
export function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Compute raw/gzip/brotli sizes for a file. */
export function measureFile(path, { compress = true } = {}) {
  const buf = readFileSync(path);
  return {
    raw: buf.length,
    gzip: compress ? gzipSize(buf) : null,
    brotli: compress ? brotliSize(buf) : null,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export const KB = 1024;
export const MB = 1024 * 1024;

export function kb(bytes) {
  return `${(bytes / KB).toFixed(1)} KB`;
}
export function mb(bytes) {
  return `${(bytes / MB).toFixed(2)} MB`;
}
export function ms(n) {
  return n == null ? "—" : `${Math.round(n)} ms`;
}
export function pct(part, whole) {
  if (!whole) return "0%";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

export async function fetchJson(url, { timeoutMs = 4000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

export async function fetchText(url, { timeoutMs = 4000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

/**
 * Poll a base URL until the agent reports ready. Requires an explicit
 * `{ ready: true }` health payload — a bare HTTP 200 (a stale server, a
 * different service, or the early liveness handler that returns before the
 * runtime is up) is NOT treated as ready. Returns the elapsed milliseconds from
 * the first probe to ready, plus the health body that satisfied the check.
 *
 * `boot-kpi.mjs` is the only caller; the strict `ready === true` gate is what
 * keeps the boot KPI from recording a false PASS against a server that never
 * actually booted, so there is intentionally no loose opt-in.
 */
export async function waitForReady(
  baseUrl,
  { timeoutMs = 300_000, intervalMs = 250, startMs } = {},
) {
  const begin = startMs ?? Date.now();
  const deadline = begin + timeoutMs;
  const healthUrl = `${baseUrl.replace(/\/$/, "")}/api/health`;
  let lastErr = "no probe yet";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        let body = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        // Require an explicit `ready === true`. The agent's /api/health returns
        // 200 (and { ready:false, startup:{phase} }) as soon as the API server
        // binds — long before the runtime is actually ready. Treating a 200 or
        // a missing `ready` field as ready (the previous behavior) timed the
        // API bind (~70ms), not agent readiness (~28s), producing a false PASS.
        if (body?.ready === true) {
          return { readyMs: Date.now() - begin, health: body };
        }
        lastErr = `health.ready=${body?.ready ?? "?"} phase=${body?.startup?.phase ?? "?"}`;
      } else {
        lastErr = `HTTP ${res.status}`;
      }
    } catch (err) {
      lastErr = err?.message ?? String(err);
    }
    await sleep(intervalMs);
  }
  throw new Error(`agent not ready after ${timeoutMs}ms (last: ${lastErr})`);
}

export function sleep(msv) {
  return new Promise((r) => setTimeout(r, msv));
}

// ---------------------------------------------------------------------------
// Result recording + git context
// ---------------------------------------------------------------------------

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
    dirty: run(["status", "--porcelain"]) ? true : false,
  };
}

/**
 * Persist a KPI result as timestamped JSON under results/<kpi>/ and also update
 * results/<kpi>/latest.json. `nowIso` must be supplied by the caller (scripts
 * pass `new Date().toISOString()` at top level — keeps this module pure).
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
  const f = join(HERE, "budgets.json");
  return JSON.parse(readFileSync(f, "utf8"));
}

export {
  basename,
  existsSync,
  extname,
  join,
  mkdirSync,
  readFileSync,
  relative,
  writeFileSync,
};
