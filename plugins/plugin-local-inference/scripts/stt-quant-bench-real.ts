#!/usr/bin/env bun
/**
 * STT quality benchmark across the published eliza-1-asr GGUF quants (#10726
 * scope item: "STT quality benchmarks per model/quant, documented per-device
 * selection"). Real weights, real fused-lib transcription — no mocks.
 *
 * For every `eliza-1-asr-<quant>.gguf` in ELIZA_ASR_QUANT_DIR (paired with the
 * dir's shared `eliza-1-asr-mmproj.gguf`), plus optionally the shipped bundle
 * ASR (ELIZA_ASR_BUNDLE — what mobile provisioning actually stages), this lane
 * transcribes the fixed-transcript Kokoro corpus and reports per-quant:
 * WER (vs the known reference texts), transcription latency, RTF, and load
 * time. Corpus caveat: the reference audio is TTS speech, so absolute WER
 * carries the TTS pronunciation floor; the CROSS-QUANT comparison is the
 * signal (identical audio for every quant).
 *
 * Exit 0 pass / 1 fail / 2 skip. STT_BENCH_REQUIRE=1 turns skips into failures.
 *
 * Env:
 *   ELIZA_INFERENCE_LIBRARY / ELIZA_INFERENCE_LIB_DIR — fused lib
 *   ELIZA_ASR_QUANT_DIR  — dir with eliza-1-asr-<quant>.gguf + eliza-1-asr-mmproj.gguf
 *   ELIZA_ASR_BUNDLE     — optional shipped-bundle row (asr/eliza-1-asr.gguf layout)
 *   ELIZA_KOKORO_MODEL_DIR — Kokoro model for one-time corpus synthesis
 *   STT_BENCH_MAX_BEST_WER — sanity ceiling for the BEST quant's mean WER (default 0.5)
 *   ELIZA_VOICE_BENCH_OUT  — report dir (default <plugin>/voice-bench-output)
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { wordErrorRate } from "@elizaos/shared/voice-wer";
import { STT_BENCH_CORPUS } from "../src/services/voice/bench-utils";
import {
	BENCH_SAMPLE_RATE,
	bootFusedFfi,
	type CorpusItem,
	defaultReportDir,
	ensureKokoroCorpus,
	makeBenchGates,
	makeQuantBundle,
	mean,
	median,
	writeBenchReport,
} from "./voice-bench-shared";

const TAG = "stt-quant-bench";
const gates = makeBenchGates(TAG, "STT_BENCH_REQUIRE");
const log = (msg: string) => console.log(`[${TAG}] ${msg}`);

interface Variant {
	name: string;
	bundleDir: string;
	sizeBytes: number;
	cleanup?: () => void;
}

interface VariantResult {
	name: string;
	sizeBytes: number;
	loadMs: number;
	meanWer: number;
	medianWer: number;
	meanTranscribeMs: number;
	firstUttMs: number;
	/** total transcribe time / total audio time — lower is better, <1 = faster than realtime. */
	rtf: number;
	/** 1/rtf — "× realtime", higher is better (asr_bench.ts convention). */
	xRealtime: number;
	utterances: Array<{
		id: string;
		reference: string;
		transcript: string;
		wer: number;
		ms: number;
		audioSeconds: number;
	}>;
}

const { ffi, libPath } = bootFusedFfi(gates);
log(`lib=${libPath}`);

// --- discover variants -------------------------------------------------------
const quantDir = process.env.ELIZA_ASR_QUANT_DIR?.trim();
const variants: Variant[] = [];
if (quantDir && existsSync(quantDir)) {
	const mmproj = path.join(quantDir, "eliza-1-asr-mmproj.gguf");
	if (!existsSync(mmproj)) {
		gates.skip(`ELIZA_ASR_QUANT_DIR has no eliza-1-asr-mmproj.gguf (${quantDir})`);
	}
	const quantFiles = readdirSync(quantDir)
		.filter((f) => /^eliza-1-asr-(?!mmproj).+\.gguf$/.test(f))
		.sort();
	for (const f of quantFiles) {
		const quantPath = path.join(quantDir, f);
		const { dir, cleanup } = makeQuantBundle(quantPath, mmproj);
		variants.push({
			name: f.replace(/^eliza-1-asr-/, "").replace(/\.gguf$/, ""),
			bundleDir: dir,
			sizeBytes: statSync(quantPath).size + statSync(mmproj).size,
			cleanup,
		});
	}
}
const shippedBundle = process.env.ELIZA_ASR_BUNDLE?.trim();
if (shippedBundle && existsSync(path.join(shippedBundle, "asr", "eliza-1-asr.gguf"))) {
	const main = path.join(shippedBundle, "asr", "eliza-1-asr.gguf");
	const mm = path.join(shippedBundle, "asr", "eliza-1-asr-mmproj.gguf");
	variants.push({
		name: "bundle-2b (shipped)",
		bundleDir: shippedBundle,
		sizeBytes: statSync(main).size + (existsSync(mm) ? statSync(mm).size : 0),
	});
}
if (variants.length === 0) {
	gates.skip(
		"no ASR variants found — set ELIZA_ASR_QUANT_DIR (eliza-1-asr-<q>.gguf + mmproj) " +
			"and/or ELIZA_ASR_BUNDLE (shipped bundle layout)",
	);
}
log(`variants: ${variants.map((v) => v.name).join(", ")}`);

// --- corpus -------------------------------------------------------------------
const corpus: CorpusItem[] = await ensureKokoroCorpus("clean", STT_BENCH_CORPUS, gates, log);
const totalAudioSec = corpus.reduce((a, c) => a + c.seconds, 0);
log(`corpus: ${corpus.length} utterances, ${totalAudioSec.toFixed(1)}s audio total`);

// --- benchmark ----------------------------------------------------------------
const results: VariantResult[] = [];
for (const variant of variants) {
	log(`--- ${variant.name} (${(variant.sizeBytes / 1e6).toFixed(0)} MB) ---`);
	const tLoad0 = performance.now();
	const ctx = ffi.create(variant.bundleDir);
	ffi.mmapAcquire(ctx, "asr");
	const loadMs = Math.round(performance.now() - tLoad0);
	const utterances: VariantResult["utterances"] = [];
	try {
		for (const item of corpus) {
			const t0 = performance.now();
			const { text } = ffi.asrTranscribeTimed({
				ctx,
				pcm: item.pcm,
				sampleRateHz: BENCH_SAMPLE_RATE,
			});
			const ms = Math.round(performance.now() - t0);
			const transcript = (text ?? "").trim();
			const wer = wordErrorRate(item.text, transcript);
			utterances.push({
				id: item.id,
				reference: item.text,
				transcript,
				wer,
				ms,
				audioSeconds: item.seconds,
			});
			log(`  ${item.id} ${ms}ms WER=${wer.toFixed(3)} "${transcript}"`);
		}
	} finally {
		ffi.mmapEvict(ctx, "asr");
		ffi.destroy(ctx);
		variant.cleanup?.();
	}
	const totalMs = utterances.reduce((a, u) => a + u.ms, 0);
	const rtf = totalMs / 1000 / totalAudioSec;
	results.push({
		name: variant.name,
		sizeBytes: variant.sizeBytes,
		loadMs,
		meanWer: mean(utterances.map((u) => u.wer)),
		medianWer: median(utterances.map((u) => u.wer)),
		meanTranscribeMs: mean(utterances.map((u) => u.ms)),
		firstUttMs: utterances[0]?.ms ?? 0,
		rtf,
		xRealtime: rtf > 0 ? 1 / rtf : 0,
		utterances,
	});
}

// --- report -------------------------------------------------------------------
const header =
	"| variant | size (MB) | load (ms) | mean WER | median WER | mean ms/utt | 1st utt (ms) | RTF | × realtime |";
const sep = "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";
const rows = results.map(
	(r) =>
		`| ${r.name} | ${(r.sizeBytes / 1e6).toFixed(0)} | ${r.loadMs} | ${r.meanWer.toFixed(3)} | ${r.medianWer.toFixed(3)} | ${Math.round(r.meanTranscribeMs)} | ${r.firstUttMs} | ${r.rtf.toFixed(3)} | ${r.xRealtime.toFixed(1)}× |`,
);
const table = [header, sep, ...rows].join("\n");
console.log(`\n${table}\n`);

const md = [
	"# STT quant benchmark — eliza-1-asr (real weights, fused lib, CPU)",
	"",
	`Host: ${process.platform}-${process.arch}. Corpus: ${corpus.length} fixed-transcript Kokoro utterances (${totalAudioSec.toFixed(1)}s). ` +
		"Absolute WER includes the TTS pronunciation floor; cross-quant deltas are the signal.",
	"",
	table,
	"",
].join("\n");
const { jsonPath, mdPath } = writeBenchReport(
	defaultReportDir(),
	"stt-quant-bench",
	{
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		host: `${process.platform}-${process.arch}`,
		lib: libPath,
		corpus: { utterances: corpus.length, totalAudioSec },
		results,
	},
	md,
);
log(`report: ${jsonPath}`);
log(`report: ${mdPath}`);

// --- gate ---------------------------------------------------------------------
// Sanity, not vanity: if even the best quant cannot transcribe the corpus, the
// published weights (or the ASR path) are broken and the lane must go RED.
const maxBestWer = Number(process.env.STT_BENCH_MAX_BEST_WER ?? "0.5");
const bestWer = Math.min(...results.map((r) => r.meanWer));
if (bestWer > maxBestWer) {
	gates.fail(
		`best-quant mean WER ${bestWer.toFixed(3)} > ${maxBestWer} — published ASR weights or decode path are broken`,
	);
}
log(`PASS (best mean WER ${bestWer.toFixed(3)} ≤ ${maxBestWer})`);
