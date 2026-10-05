import { createKpiReporter } from "../../lib/kpi-reporting.mjs";
/**
 * Shared utilities for the Mobile Resource Workbench (issue #8800).
 *
 * Pure Node ESM (built-ins only) so the harness runs with
 * `node suites/mobile-resource/<script>.mjs` without any
 * build/install step — same contract as the `loadperf` harness it mirrors.
 * Device-driving helpers (adb / xcrun simctl) degrade to a clearly-marked
 * `skipped` result when the tool or a device is absent.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * Optional root of a checked-out elizaOS/eliza repo, used only to stamp git
 * provenance (branch/commit/dirty) of the app build into recorded results.
 * The workbench itself drives the installed app on a device/simulator and
 * runs fine without a checkout — provenance is then recorded as null.
 */
export function elizaRepoDir() {
  const dir = (process.env.ELIZA_REPO_DIR ?? "").trim();
  return dir || null;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function ms(n) {
  return n == null ? "—" : `${Math.round(n)} ms`;
}
export function mb(n) {
  return n == null ? "—" : `${n.toFixed(1)} MB`;
}
export function tps(n) {
  return n == null ? "—" : `${n.toFixed(1)} tok/s`;
}
export function pct(n) {
  return n == null ? "—" : `${n.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export function median(values) {
  if (!values || values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export function sleep(msv) {
  return new Promise((r) => setTimeout(r, msv));
}

export async function fetchJson(url, { timeoutMs = 5000, ...init } = {}) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    ...init,
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Subprocess (device tools)
// ---------------------------------------------------------------------------

/**
 * Run a CLI tool, returning trimmed stdout or null on any failure (missing
 * binary, non-zero exit, no device). Never throws — callers degrade to
 * "not available on this platform" rather than failing the run.
 */
export function tryExec(cmd, args, { timeoutMs = 15_000 } = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** True when the named CLI tool is on PATH and runs. */
export function hasTool(cmd, versionArgs = ["--version"]) {
  return tryExec(cmd, versionArgs, { timeoutMs: 5000 }) !== null;
}

// ---------------------------------------------------------------------------
// Result recording + git context
// ---------------------------------------------------------------------------

export const { RESULTS_ROOT, gitInfo, recordResult, readLatest, loadBudgets } =
  createKpiReporter("mobile-resource", HERE, {
    repoRoot: elizaRepoDir(),
    recordKey: "workload",
    returnLatest: true,
  });

export { existsSync, join, mkdirSync, readFileSync, writeFileSync };
