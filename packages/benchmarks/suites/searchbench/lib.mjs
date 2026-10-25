import { createKpiReporter } from "../../lib/kpi-reporting.mjs";
/**
 * Shared utilities for the chat-message searchbench harness (#13534).
 *
 * Pure Node ESM (built-ins only) so the orchestrator (`run-all.mjs`) and the
 * checker run with `node`, while the measuring harness (`searchbench-kpi.ts`)
 * runs with `bun` because it imports the ELIZA_REPO_DIR checkout's real
 * `@elizaos/plugin-sql` PGlite adapter + migrations. Everything else is plain
 * `.mjs` with no build step. Mirrors the memperf harness contract so the two
 * benchmarks report through the same `results/<kpi>/latest.json` shape.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const {
  REPO_ROOT,
  RESULTS_ROOT,
  gitInfo,
  recordResult,
  readLatest,
  loadBudgets,
} = createKpiReporter("searchbench", HERE);

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

export { ms } from "../../lib/kpi-reporting.mjs";
