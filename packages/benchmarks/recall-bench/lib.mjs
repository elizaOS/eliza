/**
 * Shared utilities for the recall-benchmark harness (#9956).
 *
 * Pure Node ESM (built-ins only) so the orchestrator (`run-all.mjs`) runs with
 * `node` and the measuring harness (`recall-kpi.ts`) runs with
 * `bun --conditions=eliza-source` (it imports the real `@elizaos/core` recall
 * pipeline + `@elizaos/plugin-sql`) — no build step. Mirrors
 * packages/benchmarks/memperf/lib.mjs.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
/** eliza repo root (…/packages/benchmarks/recall-bench -> …) */
export const REPO_ROOT = join(HERE, "..", "..", "..");
export const RESULTS_ROOT = join(HERE, "results");

export function ms(n) {
	return n == null ? "—" : `${Math.round(n)} ms`;
}

export function pct(n) {
	return n == null ? "—" : `${(n * 100).toFixed(1)}%`;
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
	const file = join(dir, `${kpi}_${stamp}.json`);
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

export { existsSync, join, mkdirSync, readFileSync, writeFileSync };
