/**
 * Shared utilities for the Mobile Resource Workbench (issue #8800).
 *
 * Pure Node ESM (built-ins only) so the harness runs with
 * `node packages/benchmarks/mobile-resource/<script>.mjs` without any
 * build/install step — same contract as the `loadperf` harness it mirrors.
 * Device-driving helpers (adb / xcrun simctl) degrade to a clearly-marked
 * `skipped` result when the tool or a device is absent.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
/** eliza repo root (…/packages/benchmarks/mobile-resource -> …) */
export const REPO_ROOT = join(HERE, "..", "..", "..");
export const RESULTS_ROOT = join(HERE, "results");

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
 * Persist a workload result as timestamped JSON under results/<workload>/ and
 * update results/<workload>/latest.json. `nowIso` is supplied by the caller
 * (keeps this module clock-free).
 */
export function recordResult(workload, payload, nowIso) {
  const dir = join(RESULTS_ROOT, workload);
  mkdirSync(dir, { recursive: true });
  const stamp = nowIso.replace(/[:.]/g, "-");
  const record = { workload, recordedAt: nowIso, git: gitInfo(), ...payload };
  writeFileSync(join(dir, `${stamp}.json`), JSON.stringify(record, null, 2));
  writeFileSync(join(dir, "latest.json"), JSON.stringify(record, null, 2));
  return { file: join(dir, "latest.json"), record };
}

export function readLatest(workload) {
  const f = join(RESULTS_ROOT, workload, "latest.json");
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

export { existsSync, join, mkdirSync, readFileSync, writeFileSync };
