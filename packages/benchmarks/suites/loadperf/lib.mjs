import { createKpiReporter } from "../../lib/kpi-reporting.mjs";
/**
 * Shared utilities for the load/perf KPI harness.
 *
 * Pure Node ESM (built-ins only) so the suite runs with `node suites/loadperf/<kpi>.mjs`
 * without any build/install step. Optional deps (playwright, ws) are imported lazily by the KPIs
 * that need them and degrade to a clearly-marked `skipped` result when unavailable.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  brotliCompressSync,
  gzipSync,
  constants as zlibConstants,
} from "node:zlib";

export const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * These KPIs measure the selected elizaOS app checkout.
 * Set ELIZA_REPO_DIR; ELIZA_REPO remains supported for existing invocations.
 */
export function repoRoot() {
  const root = process.env.ELIZA_REPO_DIR || process.env.ELIZA_REPO;
  if (!root) {
    throw new Error(
      "Set ELIZA_REPO_DIR to the elizaOS checkout being measured",
    );
  }
  return resolve(root);
}

/** `packages/app/dist` inside the ELIZA_REPO checkout. */
export function appDist() {
  return join(repoRoot(), "packages", "app", "dist");
}

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

export const { RESULTS_ROOT, gitInfo, recordResult, readLatest, loadBudgets } =
  createKpiReporter("loadperf", HERE, {
    repoRoot: process.env.ELIZA_REPO_DIR || process.env.ELIZA_REPO || null,
    recordKey: "kpi",
    returnLatest: false,
  });

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
