import { createKpiReporter } from "../../lib/kpi-reporting.mjs";
/**
 * Shared utilities for the memory-benchmark harness.
 *
 * Pure Node ESM (built-ins only) so the orchestrator (`run-all.mjs`) and the
 * checker run with `node` and the measuring harness (`memperf-kpi.ts`) runs with
 * `bun` against the ELIZA_REPO_DIR checkout — no build step. The measuring harness is TS
 * because it imports the real `@elizaos/plugin-local-inference` services
 * (MemoryArbiter, engine, hardware probe); everything else is plain `.mjs`.
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
} = createKpiReporter("memperf", HERE);

export const MB = 1024 * 1024;

/** Current process resident set size in MB (rounded to 0.1). */
export function rssMb() {
  return Number((process.memoryUsage().rss / MB).toFixed(1));
}

export { ms } from "../../lib/kpi-reporting.mjs";
