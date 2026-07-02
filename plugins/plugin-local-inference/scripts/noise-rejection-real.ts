#!/usr/bin/env bun
/**
 * Noise-rejection regression suite (#10726 scope item: "noise-rejection /
 * WER-vs-SNR curve with a real gate"). Real weights end to end: the clean
 * corpus is real Kokoro TTS speech, the noise is mixed deterministically at
 * exact SNRs, and every condition is transcribed by the real fused eliza-1-asr.
 *
 * Noise types (sources documented in the report):
 *   white   — addNoise kind "white" (flat-spectrum, seeded)
 *   pink    — addNoise kind "pink" (1/f rumble — the suite's TRAFFIC surrogate)
 *   music   — addNoise kind "music" (seeded detuned harmonic chord)
 *   babble  — REAL competing speech: a loop of Kokoro utterances in voices
 *             disjoint from the corpus voices, mixed at exact SNR (mixAtSnr)
 *
 * Gate (fails the lane, exit 1):
 *   1. clean-corpus mean WER ≤ NOISE_MAX_CLEAN_WER
 *   2. for every noise kind, mean WER at every SNR ≥ NOISE_SNR_FLOOR_DB
 *      stays ≤ NOISE_MAX_FLOOR_WER (the documented operating floor)
 *   3. per-kind WER-vs-SNR curve is quasi-monotonic (no collapse with LESS
 *      noise, tolerance NOISE_MONOTONIC_TOL)
 *
 * Exit 0 pass / 1 fail / 2 skip. NOISE_SUITE_REQUIRE=1 turns skips into fails.
 *
 * Env:
 *   ELIZA_INFERENCE_LIBRARY / ELIZA_INFERENCE_LIB_DIR — fused lib
 *   ELIZA_ASR_BUNDLE — ASR bundle under test (asr/eliza-1-asr.gguf layout)
 *   ELIZA_KOKORO_MODEL_DIR — Kokoro model for one-time corpus synthesis
 *   NOISE_MAX_CLEAN_WER (default 0.35) / NOISE_SNR_FLOOR_DB (default 10)
 *   NOISE_MAX_FLOOR_WER (default 0.55) / NOISE_MONOTONIC_TOL (default 0.15)
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { wordErrorRate } from "@elizaos/shared/voice-wer";
import {
	BABBLE_CORPUS,
	mixAtSnr,
	quasiMonotonicViolations,
	STT_BENCH_CORPUS,
	type WerAtSnr,
} from "../src/services/voice/bench-utils";
import { addNoise, type NoiseKind } from "../src/services/voice/corpus-augment";
import {
	BENCH_SAMPLE_RATE,
	bootFusedFfi,
	defaultReportDir,
	ensureKokoroCorpus,
	makeBenchGates,
	mean,
	writeBenchReport,
} from "./voice-bench-shared";

const TAG = "noise-rejection";
const gates = makeBenchGates(TAG, "NOISE_SUITE_REQUIRE");
const log = (msg: string) => console.log(`[${TAG}] ${msg}`);

const SNRS_DB = [20, 10, 5, 0, -5] as const;
type BenchNoiseKind = NoiseKind | "babble";
const KINDS: readonly BenchNoiseKind[] = ["white", "pink", "music", "babble"];

const MAX_CLEAN_WER = Number(process.env.NOISE_MAX_CLEAN_WER ?? "0.35");
const SNR_FLOOR_DB = Number(process.env.NOISE_SNR_FLOOR_DB ?? "10");
const MAX_FLOOR_WER = Number(process.env.NOISE_MAX_FLOOR_WER ?? "0.55");
const MONOTONIC_TOL = Number(process.env.NOISE_MONOTONIC_TOL ?? "0.15");

const { ffi, libPath } = bootFusedFfi(gates);
const bundle = process.env.ELIZA_ASR_BUNDLE?.trim();
if (!bundle || !existsSync(path.join(bundle, "asr"))) {
	gates.skip(
		"no ASR bundle (set ELIZA_ASR_BUNDLE to a dir with asr/eliza-1-asr.gguf + -mmproj.gguf)",
	);
}
log(`lib=${libPath}`);
log(`bundle=${bundle}`);

const corpus = await ensureKokoroCorpus("clean", STT_BENCH_CORPUS, gates, log);
const babbleItems = await ensureKokoroCorpus("babble", BABBLE_CORPUS, gates, log);
const babbleTrack = (() => {
	const total = babbleItems.reduce((a, c) => a + c.pcm.length, 0);
	const pcm = new Float32Array(total);
	let off = 0;
	for (const item of babbleItems) {
		pcm.set(item.pcm, off);
		off += item.pcm.length;
	}
	return pcm;
})();
log(
	`corpus: ${corpus.length} utterances; babble track ${(babbleTrack.length / BENCH_SAMPLE_RATE).toFixed(1)}s ` +
		`(${babbleItems.map((b) => b.voiceId).join("+")})`,
);

const ctx = ffi.create(bundle);
ffi.mmapAcquire(ctx, "asr");

function transcribe(pcm: Float32Array): string {
	return ffi
		.asrTranscribeTimed({ ctx, pcm, sampleRateHz: BENCH_SAMPLE_RATE })
		.text.trim();
}

interface ConditionResult {
	kind: BenchNoiseKind | "clean";
	snrDb: number | null;
	meanWer: number;
	utterances: Array<{ id: string; wer: number; transcript: string }>;
}

const conditions: ConditionResult[] = [];
try {
	// Clean baseline first.
	{
		const utts = corpus.map((item) => {
			const transcript = transcribe(item.pcm);
			return { id: item.id, wer: wordErrorRate(item.text, transcript), transcript };
		});
		const m = mean(utts.map((u) => u.wer));
		conditions.push({ kind: "clean", snrDb: null, meanWer: m, utterances: utts });
		log(`clean: mean WER ${m.toFixed(3)}`);
	}
	for (const kind of KINDS) {
		for (const snrDb of SNRS_DB) {
			const utts = corpus.map((item, i) => {
				const noisy =
					kind === "babble"
						? mixAtSnr(item.pcm, babbleTrack, snrDb)
						: addNoise(item.pcm, {
								snrDb,
								kind,
								// Deterministic but distinct per (kind, snr, utterance).
								seed: 0x10726 ^ (KINDS.indexOf(kind) << 16) ^ ((snrDb + 32) << 8) ^ i,
							});
				const transcript = transcribe(noisy);
				return { id: item.id, wer: wordErrorRate(item.text, transcript), transcript };
			});
			const m = mean(utts.map((u) => u.wer));
			conditions.push({ kind, snrDb, meanWer: m, utterances: utts });
			log(`${kind} @ ${snrDb}dB: mean WER ${m.toFixed(3)}`);
		}
	}
} finally {
	ffi.mmapEvict(ctx, "asr");
	ffi.destroy(ctx);
}

// --- report -------------------------------------------------------------------
const cleanRow = conditions.find((c) => c.kind === "clean");
const kindRows = KINDS.map((kind) => {
	const cells = SNRS_DB.map((snr) => {
		const c = conditions.find((x) => x.kind === kind && x.snrDb === snr);
		return c ? c.meanWer.toFixed(3) : "—";
	});
	return `| ${kind}${kind === "pink" ? " (traffic surrogate)" : ""} | ${cells.join(" | ")} |`;
});
const table = [
	`| noise kind \\ SNR (dB) | ${SNRS_DB.join(" | ")} |`,
	`| --- | ${SNRS_DB.map(() => "---:").join(" | ")} |`,
	...kindRows,
].join("\n");
console.log(`\nclean mean WER: ${cleanRow?.meanWer.toFixed(3)}\n${table}\n`);

// --- gates --------------------------------------------------------------------
const failures: string[] = [];
if ((cleanRow?.meanWer ?? 1) > MAX_CLEAN_WER) {
	failures.push(
		`clean mean WER ${cleanRow?.meanWer.toFixed(3)} > NOISE_MAX_CLEAN_WER ${MAX_CLEAN_WER}`,
	);
}
for (const kind of KINDS) {
	const curve: WerAtSnr[] = conditions
		.filter((c) => c.kind === kind && c.snrDb !== null)
		.map((c) => ({ snrDb: c.snrDb as number, wer: c.meanWer }));
	for (const point of curve) {
		if (point.snrDb >= SNR_FLOOR_DB && point.wer > MAX_FLOOR_WER) {
			failures.push(
				`${kind} @ ${point.snrDb}dB (≥ floor ${SNR_FLOOR_DB}dB): mean WER ${point.wer.toFixed(3)} > NOISE_MAX_FLOOR_WER ${MAX_FLOOR_WER}`,
			);
		}
	}
	for (const violation of quasiMonotonicViolations(curve, MONOTONIC_TOL)) {
		failures.push(`${kind}: ${violation}`);
	}
}

const { jsonPath, mdPath } = writeBenchReport(
	defaultReportDir(),
	"noise-rejection",
	{
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		host: `${process.platform}-${process.arch}`,
		lib: libPath,
		bundle,
		thresholds: {
			maxCleanWer: MAX_CLEAN_WER,
			snrFloorDb: SNR_FLOOR_DB,
			maxFloorWer: MAX_FLOOR_WER,
			monotonicTol: MONOTONIC_TOL,
		},
		conditions,
		gateFailures: failures,
	},
	[
		"# Noise-rejection suite — WER vs SNR (real eliza-1-asr, fused lib, CPU)",
		"",
		`clean mean WER: ${cleanRow?.meanWer.toFixed(3)}`,
		"",
		table,
		"",
		failures.length > 0 ? `## GATE FAILURES\n\n${failures.map((f) => `- ${f}`).join("\n")}` : "Gate: PASS",
		"",
	].join("\n"),
);
log(`report: ${jsonPath}`);
log(`report: ${mdPath}`);

if (failures.length > 0) {
	gates.fail(`${failures.length} gate failure(s):\n  - ${failures.join("\n  - ")}`);
}
log(
	`PASS (clean ≤ ${MAX_CLEAN_WER}; WER at SNR ≥ ${SNR_FLOOR_DB}dB ≤ ${MAX_FLOOR_WER}; curves quasi-monotone tol=${MONOTONIC_TOL})`,
);
