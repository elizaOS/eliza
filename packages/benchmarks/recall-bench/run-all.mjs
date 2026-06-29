/**
 * recall-bench orchestrator (#9956).
 *
 * Spawns the measuring harness (`recall-kpi.ts`) under
 * `bun --conditions=eliza-source` (it imports the real `@elizaos/core` recall
 * pipeline + `@elizaos/plugin-sql`), then reads the recorded
 * `results/recall-bench/latest.json` and writes a consolidated dashboard under
 * `results/summary/`.
 *
 *   node packages/benchmarks/recall-bench/run-all.mjs
 *   node packages/benchmarks/recall-bench/run-all.mjs --json
 *   node packages/benchmarks/recall-bench/run-all.mjs --tier standard
 *
 * Exit codes mirror the harness:
 *   0  measured rows present, all budgets pass.
 *   1  a quality floor missed / latency ceiling crossed / fail-open not
 *      observable / broken pipeline — regression (the CI gate).
 *   2  nothing measurable on this host (harness boot failed).
 *
 * The `1` path is the CI regression gate.
 */

import { spawnSync } from "node:child_process";
import {
	HERE,
	join,
	mkdirSync,
	ms,
	pct,
	RESULTS_ROOT,
	readLatest,
	writeFileSync,
} from "./lib.mjs";

const NOW = new Date().toISOString();
const JSON_ONLY = process.argv.includes("--json");
const BUN_BIN = process.env.BUN_PATH || "bun";

// Forward any non-orchestrator-only flags (e.g. --tier/--seed) to the harness.
const FORWARD = process.argv.slice(2).filter((a) => a !== "--json");

function runHarness() {
	const res = spawnSync(
		BUN_BIN,
		["--conditions=eliza-source", join(HERE, "recall-kpi.ts"), ...FORWARD],
		{
			stdio: JSON_ONLY ? ["ignore", "ignore", "inherit"] : "inherit",
			env: process.env,
		},
	);
	if (res.error) {
		console.error(`[recall-bench] failed to spawn bun: ${res.error.message}`);
		return 1;
	}
	// 0 pass, 1 budget/regression fail, 2 nothing measurable.
	return res.status ?? 1;
}

function renderMarkdown(rec, status) {
	const lines = [];
	lines.push("# Recall-Bench KPI Dashboard");
	lines.push("");
	lines.push(`Generated: ${NOW}`);
	lines.push("");
	lines.push(`Status: **${status.toUpperCase()}**`);
	lines.push("");

	if (!rec) {
		lines.push("_no result recorded._");
		lines.push("");
		return lines.join("\n");
	}

	const s = rec.summary ?? {};
	lines.push("## Run");
	lines.push("");
	lines.push(
		`- tier: ${s.tier ?? "?"} (seed ${s.seed ?? "?"}), docs: ${s.docCount ?? "?"}, queries: ${s.queryCount ?? "?"}, fragments: ${s.ingestedFragments ?? "?"}`,
	);
	lines.push(`- embedding: ${s.embeddingModel ?? "?"}`);
	lines.push(
		`- measured: ${s.measuredModes ?? 0} modes, skipped: ${s.skippedModes ?? 0} modes`,
	);
	lines.push(
		`- fail-open recall@5 delta: ${s.failOpenDeltaAt5 == null ? "—" : s.failOpenDeltaAt5.toFixed(4)} (keyword baseline recall@5: ${pct(s.keywordBaselineRecallAt5)})`,
	);
	if (s.bootError) lines.push(`- bootError: \`${s.bootError}\``);
	lines.push("");

	lines.push("## Per recall mode");
	lines.push("");
	lines.push("| mode | measured | recall@5 | ndcg@10 | mrr | p50 | p95 |");
	lines.push("| --- | --- | --- | --- | --- | --- | --- |");
	for (const row of rec.modes ?? []) {
		if (row.measured) {
			lines.push(
				`| ${row.mode} | yes | ${pct(row.recallAt5)} | ${pct(row.ndcgAt10)} | ${row.mrr?.toFixed(3) ?? "—"} | ${ms(row.latencyMsP50)} | ${ms(row.latencyMsP95)} |`,
			);
		} else {
			lines.push(`| ${row.mode} | skip | — | — | — | — | _${row.skipReason}_ |`);
		}
	}
	lines.push("");

	lines.push("## Budget checks");
	lines.push("");
	if (!(rec.checks ?? []).length) {
		lines.push("_no measurable rows; nothing to gate._");
	}
	for (const c of rec.checks ?? []) {
		const cmp = c.direction === "min" ? "≥" : "≤";
		const v =
			c.unit === "ratio"
				? c.value == null
					? "—"
					: pct(c.value)
				: c.value == null
					? "—"
					: ms(c.value);
		const budget = c.unit === "ratio" ? pct(c.budget) : ms(c.budget);
		lines.push(`- ${c.pass ? "PASS" : "FAIL"} ${c.name}: ${v} / ${cmp} ${budget}`);
	}
	lines.push("");
	lines.push("---");
	lines.push("");
	lines.push("Budgets live in `budgets.json`. Ratchet floors up as the recall pipeline improves.");
	lines.push("");
	return lines.join("\n");
}

function main() {
	if (!JSON_ONLY) console.log(">>> recall-bench");
	const code = runHarness();
	const status = code === 0 ? "pass" : code === 2 ? "skipped" : "fail";

	const rec = readLatest("recall-bench");
	const summaryDir = join(RESULTS_ROOT, "summary");
	mkdirSync(summaryDir, { recursive: true });
	const stamp = NOW.replace(/[:.]/g, "-");
	const summary = { recordedAt: NOW, status, exitCode: code, "recall-bench": rec };
	writeFileSync(
		join(summaryDir, `${stamp}.json`),
		JSON.stringify(summary, null, 2),
	);
	writeFileSync(
		join(summaryDir, "latest.json"),
		JSON.stringify(summary, null, 2),
	);
	const md = renderMarkdown(rec, status);
	writeFileSync(join(summaryDir, `${stamp}.md`), md);
	writeFileSync(join(summaryDir, "latest.md"), md);

	if (JSON_ONLY) {
		console.log(JSON.stringify(summary, null, 2));
	} else {
		console.log(md);
		console.log(`dashboard -> ${join(summaryDir, "latest.md")}`);
	}
	// Propagate the harness exit code so CI gates on it directly.
	process.exit(code);
}

main();
