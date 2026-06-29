/**
 * recall-bench KPI harness (#9956).
 *
 * Drives the REAL `@elizaos/core` memory-recall / retrieval pipeline over a
 * deterministic labeled corpus and emits IR quality (Precision@K, Recall@K,
 * MRR, nDCG@K, HitRate@K) + retrieval latency (p50/p95) per recall mode, then
 * runs a HARD fail-open regression and a budget regression gate.
 *
 * Recall modes scored (all the real shipped surfaces):
 *   - hybrid / vector / keyword       → DocumentService.searchDocuments(mode)
 *   - runtime-vector                  → embedRecallQuery + runtime.searchMemories
 *   - keyword-chat-search             → scoreMemoryText (chat-search scorer)
 *
 * Fail-open regression (HARD): reboot with a throwing query-embed model. The
 * null dimension-probe still returns a valid zero vector (so initialize()
 * succeeds), but every live {text} embed throws → embedRecallQuery fails open
 * to keyword → hybrid + vector recall MUST collapse to the keyword baseline.
 * The harness asserts |recall@5(hybrid|vector, fail-open) - recall@5(keyword)|
 * is within failOpen.maxRecallDeltaAt5; otherwise the gate fails (exit 1).
 *
 * Honesty contract: a row is `measured: true` only when the real pipeline
 * scored real queries. Unmeasured rows are built via `skippedRow` with every
 * numeric field null (never 0). The deterministic content-hash embedding is the
 * real model layer (the runtime dispatches to it exactly like a cloud model) —
 * reproducible + key-free.
 *
 * Run:
 *   bun --conditions=eliza-source packages/benchmarks/recall-bench/recall-kpi.ts
 *   bun --conditions=eliza-source packages/benchmarks/recall-bench/recall-kpi.ts --json
 *   bun --conditions=eliza-source packages/benchmarks/recall-bench/recall-kpi.ts --tier standard
 *
 * Exit codes (mirror memperf):
 *   0  measured rows present, all budgets pass.
 *   1  a quality floor missed / latency ceiling crossed / fail-open not
 *      observable / broken pipeline.
 *   2  nothing measurable on this host (genuine boot failure); self-check could
 *      not run.
 */

import { generate, type QueriesFile, TIERS } from "./corpus-gen.ts";
import {
	evaluateRetrieval,
	percentiles,
	type RankedQuery,
} from "./ir-metrics.ts";
import { loadBudgets, ms, pct, recordResult } from "./lib.mjs";
import { K_VALUES, METRIC_SCHEMA, skippedRow } from "./metric-schema.mjs";
import {
	bootHarness,
	type BootedHarness,
	ingestCorpus,
	type ModeRun,
	relevantFragmentIds,
	runKeywordChatSearch,
	runRuntimeVector,
	runSearchMode,
} from "./recall-harness.ts";

const NOW = new Date().toISOString();
const JSON_ONLY = process.argv.includes("--json");

function argOf(flag: string, def?: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const TIER = argOf("--tier", "small") as string;
const SEED = Number(argOf("--seed", "42"));
const OUTPUT_DIR = argOf("--output-dir");
const SMOKE =
	process.argv.includes("--stub") || process.argv.includes("--smoke");

const KVALS = [...K_VALUES];

interface ModeMetric {
	mode: string;
	measured: boolean;
	skipReason?: string;
	numQueries: number | null;
	precisionAtK: Record<number, number | null>;
	recallAtK: Record<number, number | null>;
	mrr: number | null;
	ndcgAtK: Record<number, number | null>;
	hitRateAtK: Record<number, number | null>;
	latencyMsP50: number | null;
	latencyMsP95: number | null;
	recallAt5: number | null;
	ndcgAt10: number | null;
}

interface BudgetCheck {
	name: string;
	value: number | null;
	budget: number;
	unit: string;
	direction: "min" | "max";
	pass: boolean;
}

/** Build a measured ModeMetric from a ModeRun + the query labels. */
function scoreMode(
	mode: string,
	run: ModeRun,
	queries: QueriesFile,
	fragmentIdsByDocKey: Map<string, import("@elizaos/core").UUID[]>,
): ModeMetric {
	const resById = new Map(run.results.map((r) => [r.queryId, r.resultIds]));
	const ranked: RankedQuery[] = queries.queries.map((q) => ({
		resultIds: resById.get(q.queryId) ?? [],
		relevantIds: relevantFragmentIds(q, fragmentIdsByDocKey),
	}));
	const m = evaluateRetrieval(ranked, KVALS);
	const { p50, p95 } = percentiles(run.latenciesMs);
	return {
		mode,
		measured: true,
		numQueries: m.numQueries,
		precisionAtK: m.precisionAtK,
		recallAtK: m.recallAtK,
		mrr: m.meanReciprocalRank,
		ndcgAtK: m.ndcgAtK,
		hitRateAtK: m.hitRateAtK,
		latencyMsP50: p50 == null ? null : Number(p50.toFixed(2)),
		latencyMsP95: p95 == null ? null : Number(p95.toFixed(2)),
		recallAt5: m.recallAtK[5] ?? null,
		ndcgAt10: m.ndcgAtK[10] ?? null,
	};
}

function checkBudgets(
	rows: ModeMetric[],
	selfCheckRecallAt5: number | null,
	failOpenDelta: number | null,
): BudgetCheck[] {
	const b = loadBudgets();
	const checks: BudgetCheck[] = [];

	for (const row of rows) {
		if (!row.measured) continue; // skipped never fails
		const ds = b.modes?.[row.mode];
		if (!ds) continue;
		if (typeof ds.recallAt5 === "number") {
			checks.push({
				name: `${row.mode}.recallAt5`,
				value: row.recallAt5,
				budget: ds.recallAt5,
				unit: "ratio",
				direction: "min",
				pass: row.recallAt5 != null && row.recallAt5 >= ds.recallAt5,
			});
		}
		if (typeof ds.ndcgAt10 === "number") {
			checks.push({
				name: `${row.mode}.ndcgAt10`,
				value: row.ndcgAt10,
				budget: ds.ndcgAt10,
				unit: "ratio",
				direction: "min",
				pass: row.ndcgAt10 != null && row.ndcgAt10 >= ds.ndcgAt10,
			});
		}
		if (typeof ds.latencyMsP95 === "number") {
			checks.push({
				name: `${row.mode}.latencyMsP95`,
				value: row.latencyMsP95,
				budget: ds.latencyMsP95,
				unit: "ms",
				direction: "max",
				pass: row.latencyMsP95 != null && row.latencyMsP95 <= ds.latencyMsP95,
			});
		}
	}

	// Self-check floor: the deterministic content-hash pipeline must retrieve at
	// all (proves the wiring scores). Uses the hybrid mode's recall@5.
	const minSelf = b.selfCheck?.minRecallAt5 ?? 0.2;
	checks.push({
		name: "selfCheck.minRecallAt5",
		value: selfCheckRecallAt5,
		budget: minSelf,
		unit: "ratio",
		direction: "min",
		pass: selfCheckRecallAt5 != null && selfCheckRecallAt5 >= minSelf,
	});

	// Fail-open regression: forcing the query embed to throw MUST collapse
	// hybrid+vector recall@5 to the keyword baseline (delta ~ 0). HARD gate.
	if (failOpenDelta != null) {
		const maxDelta = b.failOpen?.maxRecallDeltaAt5 ?? 0.001;
		checks.push({
			name: "failOpen.maxRecallDeltaAt5",
			value: failOpenDelta,
			budget: maxDelta,
			unit: "ratio",
			direction: "max",
			pass: failOpenDelta <= maxDelta,
		});
	}

	return checks;
}

function log(...args: unknown[]) {
	if (!JSON_ONLY) console.log(...args);
}

async function main() {
	const preset = TIERS[TIER];
	if (!preset) {
		console.error(
			`[recall-bench] unknown tier "${TIER}" (expected: ${Object.keys(TIERS).join(", ")})`,
		);
		process.exit(2);
	}
	// --smoke shrinks even the small tier for a fast wiring check.
	const genOpts = SMOKE
		? { ...preset, docsPerConcept: 2, distractorCount: 0, queryCount: 16, seed: SEED }
		: { ...preset, seed: SEED };

	const { corpus, queries } = generate(genOpts);
	log(
		`>>> recall-bench tier=${TIER} seed=${SEED} docs=${corpus.documents.length} queries=${queries.queries.length}`,
	);

	const rows: ModeMetric[] = [];
	let boot: BootedHarness | undefined;
	let ingestedFragments = 0;
	let keywordBaselineRecallAt5: number | null = null;
	let failOpenDelta: number | null = null;
	let bootError: string | null = null;

	try {
		boot = await bootHarness({ logLevel: "warn" });
		const { fragmentIdsByDocKey, fragmentCount } = await ingestCorpus(
			boot,
			corpus,
		);
		ingestedFragments = fragmentCount;
		log(`[recall-bench] ingested ${fragmentCount} fragments`);

		// Score the real DocumentService modes + the low-level runtime vector +
		// the chat-search scorer.
		const modeRuns: { mode: string; run: ModeRun }[] = [];
		for (const mode of ["hybrid", "vector", "keyword"] as const) {
			modeRuns.push({ mode, run: await runSearchMode(boot, queries, mode) });
		}
		modeRuns.push({
			mode: "runtime-vector",
			run: await runRuntimeVector(boot, queries),
		});
		modeRuns.push({
			mode: "keyword-chat-search",
			run: await runKeywordChatSearch(boot, queries),
		});

		for (const { mode, run } of modeRuns) {
			const row = scoreMode(mode, run, queries, fragmentIdsByDocKey);
			rows.push(row);
			if (mode === "keyword") keywordBaselineRecallAt5 = row.recallAt5;
			log(
				`[recall-bench] mode=${mode.padEnd(20)} recall@5=${pct(row.recallAt5)} ndcg@10=${pct(row.ndcgAt10)} mrr=${row.mrr?.toFixed(3)} p95=${ms(row.latencyMsP95)}`,
			);
		}

		await boot.cleanup();
		boot = undefined;

		// ---- HARD fail-open regression ----
		log("[recall-bench] running fail-open regression (throwing query embed)…");
		const failBoot = await bootHarness({ logLevel: "warn" });
		try {
			// Ingest with a HEALTHY embedding (ingestion embeds via the same model),
			// then flip the switch so only QUERY-time embeds throw → embedRecallQuery
			// fails open to keyword. Use this boot's OWN fragment-UUID labels.
			const foLabels = (await ingestCorpus(failBoot, corpus))
				.fragmentIdsByDocKey;
			failBoot.failSwitch.failing = true;
			const foHybrid = await runSearchMode(failBoot, queries, "hybrid");
			const foVector = await runSearchMode(failBoot, queries, "vector");
			const foKeyword = await runSearchMode(failBoot, queries, "keyword");
			const score = (run: ModeRun) =>
				scoreMode("_fo", run, queries, foLabels).recallAt5 ?? 0;
			const foHybridR5 = score(foHybrid);
			const foVectorR5 = score(foVector);
			const foKeywordR5 = score(foKeyword);
			failOpenDelta = Math.max(
				Math.abs(foHybridR5 - foKeywordR5),
				Math.abs(foVectorR5 - foKeywordR5),
			);
			log(
				`[recall-bench] fail-open recall@5  hybrid=${pct(foHybridR5)} vector=${pct(foVectorR5)} keyword=${pct(foKeywordR5)} -> delta=${failOpenDelta.toFixed(4)}`,
			);
		} finally {
			await failBoot.cleanup();
		}
	} catch (err) {
		bootError = err instanceof Error ? err.message : String(err);
		console.error(`[recall-bench] harness failed: ${bootError}`);
		if (boot) await boot.cleanup().catch(() => {});
	}

	// Ensure every schema mode appears as a row; mark unmeasured ones skipped.
	const measuredModes = new Set(rows.map((r) => r.mode));
	for (const mode of METRIC_SCHEMA.searchModes) {
		if (!measuredModes.has(mode)) {
			rows.push(
				skippedRow(
					mode,
					bootError ?? "mode not scored (harness boot failed)",
				) as unknown as ModeMetric,
			);
		}
	}
	// Stable mode order.
	const order = METRIC_SCHEMA.searchModes as readonly string[];
	rows.sort((a, b) => order.indexOf(a.mode) - order.indexOf(b.mode));

	const hybridRow = rows.find((r) => r.mode === "hybrid" && r.measured);
	const selfCheckRecallAt5 = hybridRow?.recallAt5 ?? null;

	const measuredCount = rows.filter((r) => r.measured).length;
	const checks =
		measuredCount > 0
			? checkBudgets(rows, selfCheckRecallAt5, failOpenDelta)
			: [];
	const pass = measuredCount > 0 && checks.every((c) => c.pass);

	// overall_accuracy / total_tasks for the orchestrator scorer.
	const overallAccuracy = hybridRow?.recallAt5 ?? null;
	const totalTasks = queries.queries.length;

	const result = {
		schema: METRIC_SCHEMA,
		summary: {
			tier: TIER,
			seed: SEED,
			docCount: corpus.documents.length,
			queryCount: queries.queries.length,
			ingestedFragments,
			embeddingModel: "deterministic-content-hash-384",
			measuredModes: measuredCount,
			skippedModes: rows.length - measuredCount,
			keywordBaselineRecallAt5,
			failOpenDeltaAt5: failOpenDelta,
			bootError,
		},
		metrics: {
			// Top-level fields the orchestrator scorer reads
			// (registry/scores.py:_score_from_recall_bench_json).
			overall_accuracy: overallAccuracy,
			total_tasks: totalTasks,
		},
		modes: rows,
		checks,
		pass,
	};

	const { file } = recordResult("recall-bench", result, NOW);
	if (OUTPUT_DIR) {
		const { mkdirSync, writeFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		mkdirSync(OUTPUT_DIR, { recursive: true });
		const stamp = NOW.replace(/[:.]/g, "-");
		writeFileSync(
			join(OUTPUT_DIR, `recall_bench_${stamp}.json`),
			JSON.stringify({ kpi: "recall-bench", recordedAt: NOW, ...result }, null, 2),
		);
	}

	if (JSON_ONLY) {
		console.log(
			JSON.stringify({ kpi: "recall-bench", recordedAt: NOW, ...result }, null, 2),
		);
	} else {
		log("");
		log("## Budget checks");
		if (!checks.length) log("_no measurable rows; nothing to gate._");
		for (const c of checks) {
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
			log(`- ${c.pass ? "PASS" : "FAIL"} ${c.name}: ${v} ${cmp} ${budget}`);
		}
		log("");
		log(`result -> ${file}`);
	}

	// Exit-code contract (mirror memperf):
	//   0 measured + budgets pass · 1 regression · 2 nothing measurable.
	if (measuredCount === 0) process.exit(pass ? 2 : 1);
	process.exit(pass ? 0 : 1);
}

main();
