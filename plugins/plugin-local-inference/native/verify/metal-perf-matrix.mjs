#!/usr/bin/env node
/**
 * metal-perf-matrix.mjs — per-tier Metal (Apple GPU) throughput matrix for the
 * staged Eliza-1 text bundles (#9580).
 *
 * The §8 kernel gate (`make metal-verify`) proves correctness; this proves
 * *throughput per tier* on real hardware — the "Metal per-tier (M-series)"
 * verification-matrix row #9580 asks for. It discovers the text GGUF for each
 * Eliza-1 tier on disk, runs `llama-bench` (prefill pp512 + decode tg128, flash
 * attention on, all layers on GPU), and emits a markdown table + JSON report.
 *
 * Usage:
 *   node metal-perf-matrix.mjs [--bench <llama-bench>] [--models-dir <dir>]
 *                              [--depths 0,4096,16000] [--out <dir>] [--json]
 *
 * Resolution (first hit wins):
 *   --bench / $LLAMA_BENCH, else common fork-build locations.
 *   --models-dir / $MODELS_DIR, else the curated Eliza-1 model dirs.
 *
 * This is read-only w.r.t. the repo: it shells out to `llama-bench` and writes
 * only under the chosen `--out` dir. It does NOT build anything.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const TIER_ORDER = [
	"2b",
	"4b",
	"9b",
	"27b",
	"27b-256k",
];

function parseArgs(argv) {
	const args = {
		bench: process.env.LLAMA_BENCH ?? null,
		modelsDir: process.env.MODELS_DIR ?? null,
		depths: null,
		out: null,
		json: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--bench") args.bench = argv[++i];
		else if (a === "--models-dir") args.modelsDir = argv[++i];
		else if (a === "--depths") args.depths = argv[++i];
		else if (a === "--out") args.out = argv[++i];
		else if (a === "--json") args.json = true;
		else if (a === "--help" || a === "-h") {
			console.log(
				"Usage: metal-perf-matrix.mjs [--bench <path>] [--models-dir <dir>] [--depths 0,4096,16000] [--out <dir>] [--json]",
			);
			process.exit(0);
		}
	}
	return args;
}

function resolveBench(explicit) {
	const candidates = [
		explicit,
		path.join(
			process.cwd(),
			".tmp/llama-mtp-build/bin/llama-bench",
		),
		path.join(homedir(), "eliza-workspace/llama-build-test/build/bin/llama-bench"),
	].filter(Boolean);
	// Plus any fork install under ~/.eliza/local-inference/bin/mtp/<triple>/.
	const mtpRoot = path.join(homedir(), ".eliza/local-inference/bin/mtp");
	if (existsSync(mtpRoot)) {
		for (const triple of safeReaddir(mtpRoot)) {
			candidates.push(path.join(mtpRoot, triple, "llama-bench"));
		}
	}
	for (const c of candidates) if (c && existsSync(c)) return c;
	throw new Error(
		`llama-bench not found. Pass --bench <path> or set $LLAMA_BENCH. Tried:\n  ${candidates.join("\n  ")}`,
	);
}

function defaultModelDirs() {
	return [
		path.join(homedir(), ".eliza/local-inference/models"),
		path.join(homedir(), "elizacache/local-inference/models"),
	].filter(existsSync);
}

function safeReaddir(dir) {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/** Find the text GGUF for each tier: `<dir>/eliza-1-<tier>.bundle/text/*.gguf`. */
export function discoverTierModels(modelDirs) {
	const found = new Map(); // tier -> gguf path
	for (const root of modelDirs) {
		for (const entry of safeReaddir(root)) {
			const m = /^eliza-1-(.+)\.bundle$/.exec(entry);
			if (!m) continue;
			const tier = m[1];
			if (found.has(tier)) continue; // first dir wins
			const textDir = path.join(root, entry, "text");
			const gguf = safeReaddir(textDir)
				.filter((f) => f.endsWith(".gguf"))
				.sort()[0];
			if (gguf) found.set(tier, path.join(textDir, gguf));
		}
	}
	// Stable, catalog-ordered output.
	const ordered = [];
	for (const tier of TIER_ORDER) {
		if (found.has(tier)) ordered.push([tier, found.get(tier)]);
	}
	for (const [tier, p] of found) {
		if (!TIER_ORDER.includes(tier)) ordered.push([tier, p]);
	}
	return ordered;
}

function runBench(bench, model, depths) {
	const args = ["-m", model, "-p", "512", "-n", "128", "-ngl", "99", "-fa", "1"];
	if (depths) args.push("-d", depths);
	args.push("-o", "json");
	const stdout = execFileSync(bench, args, {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		env: { ...process.env, DYLD_LIBRARY_PATH: path.dirname(bench) },
	});
	return JSON.parse(stdout);
}

/** Reduce llama-bench rows into {arch, sizeMiB, params, pp512, tg128, depthDecode}. */
export function summarize(rows) {
	const r0 = rows[0] ?? {};
	const out = {
		arch: r0.model_type ?? "?",
		sizeMiB: (r0.model_size ?? 0) / (1024 * 1024),
		params: (r0.model_n_params ?? 0) / 1e6,
		flashAttn: r0.flash_attn ?? 0,
		pp512: null,
		tg128: null,
		depthDecode: {}, // depth -> tg t/s
	};
	for (const r of rows) {
		const ts = { avg: r.avg_ts, sd: r.stddev_ts };
		if (r.n_prompt > 0 && r.n_gen === 0 && r.n_depth === 0) out.pp512 = ts;
		else if (r.n_gen > 0 && r.n_prompt === 0) {
			if ((r.n_depth ?? 0) === 0) out.tg128 = ts;
			out.depthDecode[r.n_depth ?? 0] = ts;
		}
	}
	return out;
}

export function fmt(ts) {
	return ts ? `${ts.avg.toFixed(1)} ± ${ts.sd.toFixed(0)}` : "—";
}

export function buildMarkdown(results, meta) {
	const depths = meta.depths
		? meta.depths.split(",").map((d) => Number.parseInt(d, 10))
		: [];
	const header = [
		"| tier | arch (as loaded) | size (MiB) | params | pp512 t/s | tg128 t/s",
		...depths.map((d) => ` | tg@d=${d}`),
		" |",
	].join("");
	const sep = `|${"---|".repeat(6 + depths.length)}`;
	const lines = [header, sep];
	for (const { tier, summary } of results) {
		const cells = [
			tier,
			summary.arch,
			summary.sizeMiB.toFixed(0),
			`${summary.params.toFixed(0)}M`,
			fmt(summary.pp512),
			fmt(summary.tg128),
			...depths.map((d) => fmt(summary.depthDecode[d])),
		];
		lines.push(`| ${cells.join(" | ")} |`);
	}
	return lines.join("\n");
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const bench = resolveBench(args.bench);
	const modelDirs = args.modelsDir ? [args.modelsDir] : defaultModelDirs();
	if (modelDirs.length === 0) {
		throw new Error(
			"No model dirs found. Pass --models-dir <dir> or set $MODELS_DIR.",
		);
	}
	const tiers = discoverTierModels(modelDirs);
	if (tiers.length === 0) {
		throw new Error(`No eliza-1-*.bundle text GGUFs under: ${modelDirs.join(", ")}`);
	}

	console.error(`[metal-perf-matrix] bench: ${bench}`);
	console.error(`[metal-perf-matrix] tiers: ${tiers.map(([t]) => t).join(", ")}`);

	const results = [];
	for (const [tier, model] of tiers) {
		console.error(`[metal-perf-matrix] benchmarking ${tier} …`);
		try {
			const rows = runBench(bench, model, args.depths);
			results.push({ tier, model, summary: summarize(rows), rows });
		} catch (err) {
			console.error(`[metal-perf-matrix] tier ${tier} FAILED: ${err.message}`);
			results.push({ tier, model, error: err.message });
		}
	}

	const ok = results.filter((r) => !r.error);
	const meta = { bench, depths: args.depths, modelDirs };
	const markdown = buildMarkdown(ok, meta);
	console.log(markdown);

	if (args.out) {
		mkdirSync(args.out, { recursive: true });
		const report = { meta, results };
		const jsonPath = path.join(args.out, "metal-perf-matrix.json");
		writeFileSync(jsonPath, JSON.stringify(report, null, 2));
		const mdPath = path.join(args.out, "metal-perf-matrix.md");
		writeFileSync(mdPath, `${markdown}\n`);
		console.error(`[metal-perf-matrix] wrote ${jsonPath} + ${mdPath}`);
	}
	if (args.json) console.error(JSON.stringify({ meta, results }, null, 2));
}

const invokedDirectly =
	process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
	main().catch((err) => {
		console.error(err.stack ?? String(err));
		process.exit(1);
	});
}
