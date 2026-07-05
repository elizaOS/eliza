/**
 * Shared utilities for the chat-message searchbench harness (#13534).
 *
 * Pure Node ESM (built-ins only) so the orchestrator (`run-all.mjs`) and the
 * checker run with `node`, while the measuring harness (`searchbench-kpi.ts`)
 * runs with `bun --conditions=eliza-source` because it imports the real
 * `@elizaos/plugin-sql` PGlite adapter + migrations. Everything else is plain
 * `.mjs` with no build step. Mirrors the memperf harness contract so the two
 * benchmarks report through the same `results/<kpi>/latest.json` shape.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
/** eliza repo root (…/packages/benchmarks/searchbench -> …) */
export const REPO_ROOT = join(HERE, "..", "..", "..");
export const RESULTS_ROOT = join(HERE, "results");

export function ms(n) {
  return n == null ? "—" : `${Math.round(n)} ms`;
}

/** Round to `d` decimals, or null through. A metric is null when unmeasured. */
export function round(n, d = 4) {
  if (n == null || Number.isNaN(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/** p-quantile of a numeric array via nearest-rank; null on empty input. */
export function quantile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
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
  writeFileSync(join(dir, `${stamp}.json`), JSON.stringify(record, null, 2));
  writeFileSync(join(dir, "latest.json"), JSON.stringify(record, null, 2));
  return { file: join(dir, `${stamp}.json`), record };
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

export { existsSync, join, mkdirSync, readFileSync, writeFileSync };
