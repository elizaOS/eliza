#!/usr/bin/env bun
/**
 * Speaker-isolation benchmark (#10726 scope item: "speaker isolation /
 * attribution accuracy on two-speaker audio"). Real weights end to end:
 * two REAL Kokoro voices (af_bella / am_michael) speak a fixed dialogue, and
 * the real fused pyannote-segmentation-3.0 diarizer + WeSpeaker ResNet34-LM
 * speaker encoder attribute who spoke when.
 *
 * Slices:
 *   1. encoder attribution — enroll each speaker on their first turn, attribute
 *      every later turn by cosine distance (product enrollment flow). Gate.
 *   2. diarizer DER — diarize the gap-separated timeline in 5 s windows,
 *      globalize window-local labels through the speaker encoder, score with
 *      the NIST-style DER scorer (#9427 pipeline). Gate.
 *   3. #9427 model-free acoustic attributor (mean-MFCC OnlineSpeakerClusterer)
 *      on the same turns — comparison row, informational.
 *   4. overlap probe — both voices simultaneously in one window; report whether
 *      the diarizer sees ≥2 speakers / overlap. Informational.
 *
 * Exit 0 pass / 1 fail / 2 skip. SPEAKER_ISO_REQUIRE=1 turns skips into fails.
 *
 * Env:
 *   ELIZA_INFERENCE_LIBRARY / ELIZA_INFERENCE_LIB_DIR — fused lib
 *   ELIZA_DIARIZ_GGUF  (or ELIZA_TEST_DIARIZ_GGUF)  — pyannote-segmentation-3.0.gguf
 *   ELIZA_SPEAKER_GGUF (or ELIZA_TEST_SPEAKER_GGUF) — wespeaker-resnet34-lm.gguf
 *   ELIZA_KOKORO_MODEL_DIR — Kokoro model for one-time corpus synthesis
 *   SPEAKER_ISO_MIN_ACC (default 0.8) / SPEAKER_ISO_MAX_DER (default 0.6)
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	attributeByEnrollment,
	buildSpeakerTimeline,
	TWO_SPEAKER_DIALOGUE,
	type EmbeddedTurn,
} from "../src/services/voice/bench-utils";
import { measureRms } from "../src/services/voice/corpus-augment";
import { OnlineSpeakerClusterer } from "../src/services/voice/acoustic-speaker-attribution";
import {
	computeDiarizationErrorRate,
	type DiarizationSegment,
} from "../src/services/voice/diarization-error-rate";
import { voiceSpeakerDistance } from "../src/services/voice/speaker/encoder-ggml";
import { FusedDiarizer } from "../src/services/voice/speaker/diarizer-fused";
import { FusedSpeakerEncoder } from "../src/services/voice/speaker/encoder-fused";
import {
	BENCH_SAMPLE_RATE,
	bootFusedFfi,
	defaultReportDir,
	ensureKokoroCorpus,
	makeBenchGates,
	writeBenchReport,
} from "./voice-bench-shared";

const TAG = "speaker-isolation";
const gates = makeBenchGates(TAG, "SPEAKER_ISO_REQUIRE");
const log = (msg: string) => console.log(`[${TAG}] ${msg}`);

const MIN_ACC = Number(process.env.SPEAKER_ISO_MIN_ACC ?? "0.8");
const MAX_DER = Number(process.env.SPEAKER_ISO_MAX_DER ?? "0.6");
const WINDOW_SAMPLES = BENCH_SAMPLE_RATE * 5; // pyannote 5 s window
const MIN_EMBED_SAMPLES = BENCH_SAMPLE_RATE; // WeSpeaker needs ≥1 s

const { ffi, libPath } = bootFusedFfi(gates);
const diarizGguf = (
	process.env.ELIZA_DIARIZ_GGUF ?? process.env.ELIZA_TEST_DIARIZ_GGUF
)?.trim();
const speakerGguf = (
	process.env.ELIZA_SPEAKER_GGUF ?? process.env.ELIZA_TEST_SPEAKER_GGUF
)?.trim();
if (!diarizGguf || !existsSync(diarizGguf)) {
	gates.skip("no diarizer GGUF (set ELIZA_DIARIZ_GGUF to pyannote-segmentation-3.0.gguf)");
}
if (!speakerGguf || !existsSync(speakerGguf)) {
	gates.skip("no speaker-encoder GGUF (set ELIZA_SPEAKER_GGUF to wespeaker-resnet34-lm.gguf)");
}
if (!FusedDiarizer.isSupported(ffi)) {
	gates.skip("fused lib does not link the pyannote diarizer (eliza_inference_diariz_*)");
}
if (!FusedSpeakerEncoder.isSupported(ffi)) {
	gates.skip("fused lib does not link the WeSpeaker encoder (eliza_inference_speaker_*)");
}
log(`lib=${libPath}`);
log(`diarizer=${diarizGguf}`);
log(`speaker-encoder=${speakerGguf}`);

const turns = await ensureKokoroCorpus("two-speaker", TWO_SPEAKER_DIALOGUE, gates, log);
const speakerOf = new Map(TWO_SPEAKER_DIALOGUE.map((t) => [t.id, t.speaker]));
const timeline = buildSpeakerTimeline(
	turns.map((t) => ({ speaker: speakerOf.get(t.id) as string, pcm: t.pcm })),
	BENCH_SAMPLE_RATE,
	600,
);
log(
	`timeline: ${turns.length} turns, ${(timeline.pcm.length / BENCH_SAMPLE_RATE).toFixed(1)}s, ` +
		`speakers ${[...new Set(timeline.segments.map((s) => s.speaker))].join("/")}`,
);

const ctxDir = mkdtempSync(path.join(os.tmpdir(), "speaker-iso-"));
const ctx = ffi.create(ctxDir);
const encoder = await FusedSpeakerEncoder.load({ ffi, ctx, ggufPath: speakerGguf });
const diarizer = await FusedDiarizer.load({ ffi, ctx, ggufPath: diarizGguf });

interface Report {
	attribution: ReturnType<typeof attributeByEnrollment>;
	mfccAccuracy: number;
	der: ReturnType<typeof computeDiarizationErrorRate>;
	hypothesis: DiarizationSegment[];
	droppedShortMs: number;
	overlap: { localSpeakerCount: number; hasOverlap: boolean };
}

let report: Report;
try {
	// --- slice 1: encoder attribution over ground-truth turns -------------------
	const embedded: EmbeddedTurn[] = [];
	for (const turn of turns) {
		const embedding = await encoder.encode(turn.pcm);
		embedded.push({ id: turn.id, speaker: speakerOf.get(turn.id) as string, embedding });
	}
	const attribution = attributeByEnrollment(embedded);
	log(
		`encoder attribution: ${attribution.correct}/${attribution.scored} correct ` +
			`(acc ${attribution.accuracy.toFixed(3)}, intra ${attribution.intraMean.toFixed(3)}, ` +
			`inter ${attribution.interMean.toFixed(3)}, margin ${attribution.margin.toFixed(3)})`,
	);

	// --- slice 3: #9427 model-free acoustic attributor (comparison) -------------
	const clusterer = new OnlineSpeakerClusterer();
	const assigned = turns.map((turn) => ({
		speaker: speakerOf.get(turn.id) as string,
		cluster: clusterer.assignAudio(turn.pcm, BENCH_SAMPLE_RATE),
	}));
	const clusters = [...new Set(assigned.map((a) => a.cluster).filter(Boolean))] as string[];
	let mfccBest = 0;
	// Optimal cluster→speaker mapping (2 speakers → try both assignments).
	for (const flip of [false, true]) {
		const mapping = new Map<string, string>(
			clusters.map((c, i) => [c, (i % 2 === 0) !== flip ? "A" : "B"]),
		);
		const correct = assigned.filter(
			(a) => a.cluster && mapping.get(a.cluster) === a.speaker,
		).length;
		mfccBest = Math.max(mfccBest, correct / assigned.length);
	}
	log(`mfcc attributor (#9427): best-mapping accuracy ${mfccBest.toFixed(3)} (${clusters.length} clusters)`);

	// --- slice 2: diarizer over 5 s windows + encoder globalization --------------
	const enrollment = new Map<string, number[]>();
	for (const e of embedded) {
		if (!enrollment.has(e.speaker)) enrollment.set(e.speaker, Array.from(e.embedding));
	}
	const hypothesis: DiarizationSegment[] = [];
	let droppedShortMs = 0;
	for (let off = 0; off < timeline.pcm.length; off += WINDOW_SAMPLES) {
		const window = new Float32Array(WINDOW_SAMPLES);
		window.set(timeline.pcm.subarray(off, Math.min(off + WINDOW_SAMPLES, timeline.pcm.length)));
		const out = await diarizer.diarizeWindow(window);
		const windowStartMs = (off / BENCH_SAMPLE_RATE) * 1000;
		for (const seg of out.segments) {
			const absStart = windowStartMs + seg.startMs;
			const absEnd = windowStartMs + seg.endMs;
			const s0 = Math.round((absStart / 1000) * BENCH_SAMPLE_RATE);
			const s1 = Math.round((absEnd / 1000) * BENCH_SAMPLE_RATE);
			const pcm = timeline.pcm.subarray(s0, Math.min(s1, timeline.pcm.length));
			if (pcm.length < MIN_EMBED_SAMPLES) {
				droppedShortMs += absEnd - absStart;
				continue;
			}
			const emb = Array.from(await encoder.encode(pcm));
			let best: { speaker: string; d: number } | null = null;
			for (const [speaker, ref] of enrollment) {
				const d = voiceSpeakerDistance(emb, ref);
				if (!best || d < best.d) best = { speaker, d };
			}
			if (best) hypothesis.push({ speaker: best.speaker, startMs: absStart, endMs: absEnd });
		}
	}
	const der = computeDiarizationErrorRate(
		timeline.segments.map((s) => ({ speaker: s.speaker, startMs: s.startMs, endMs: s.endMs })),
		hypothesis,
	);
	log(
		`diarizer DER ${der.der.toFixed(3)} (missed ${der.missedMs}ms, falseAlarm ${der.falseAlarmMs}ms, ` +
			`confusion ${der.confusionMs}ms / ref ${der.totalReferenceMs}ms; dropped-short ${Math.round(droppedShortMs)}ms)`,
	);

	// --- slice 4: overlap probe (informational) ----------------------------------
	const a = turns[0].pcm;
	const b = turns[1].pcm;
	const overlapPcm = new Float32Array(WINDOW_SAMPLES);
	const scaleB = (measureRms(a) || 1e-6) / (measureRms(b) || 1e-6);
	for (let i = 0; i < WINDOW_SAMPLES; i++) {
		overlapPcm[i] = (i < a.length ? a[i] : 0) + (i < b.length ? b[i] * scaleB : 0);
	}
	const overlapOut = await diarizer.diarizeWindow(overlapPcm);
	const overlap = {
		localSpeakerCount: overlapOut.localSpeakerCount,
		hasOverlap: overlapOut.segments.some((s) => s.hasOverlap),
	};
	log(
		`overlap probe: localSpeakerCount=${overlap.localSpeakerCount} hasOverlap=${overlap.hasOverlap}`,
	);

	report = { attribution, mfccAccuracy: mfccBest, der, hypothesis, droppedShortMs, overlap };
} finally {
	await diarizer.dispose();
	await encoder.dispose();
	ffi.destroy(ctx);
	rmSync(ctxDir, { recursive: true, force: true });
}

// --- report -------------------------------------------------------------------
const perTurnTable = [
	"| turn | speaker | attributed | dist(own) | dist(other) | correct |",
	"| --- | --- | --- | ---: | ---: | --- |",
	...report.attribution.perTurn.map(
		(t) =>
			`| ${t.id} | ${t.speaker} | ${t.attributed} | ${t.distanceToOwn.toFixed(3)} | ${t.distanceToNearestOther.toFixed(3)} | ${t.correct ? "✓" : "✗"} |`,
	),
].join("\n");
const md = [
	"# Speaker-isolation benchmark — two real Kokoro voices, real diarizer + encoder (CPU)",
	"",
	`Voices: af_bella (A) / am_michael (B), ${TWO_SPEAKER_DIALOGUE.length}-turn dialogue, 600 ms gaps.`,
	"",
	`- encoder attribution: **${report.attribution.correct}/${report.attribution.scored}** ` +
		`(accuracy ${report.attribution.accuracy.toFixed(3)}, margin ${report.attribution.margin.toFixed(3)})`,
	`- diarizer DER: **${report.der.der.toFixed(3)}** (missed ${report.der.missedMs} ms, ` +
		`false-alarm ${report.der.falseAlarmMs} ms, confusion ${report.der.confusionMs} ms, ` +
		`dropped-short ${Math.round(report.droppedShortMs)} ms)`,
	`- #9427 mean-MFCC attributor (model-free comparison): accuracy ${report.mfccAccuracy.toFixed(3)}`,
	`- overlap probe: localSpeakerCount=${report.overlap.localSpeakerCount}, hasOverlap=${report.overlap.hasOverlap}`,
	"",
	perTurnTable,
	"",
].join("\n");
const { jsonPath, mdPath } = writeBenchReport(
	defaultReportDir(),
	"speaker-isolation",
	{
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		host: `${process.platform}-${process.arch}`,
		lib: libPath,
		diarizGguf,
		speakerGguf,
		thresholds: { minAccuracy: MIN_ACC, maxDer: MAX_DER },
		...report,
		attribution: report.attribution,
	},
	md,
);
log(`report: ${jsonPath}`);
log(`report: ${mdPath}`);

// --- gates --------------------------------------------------------------------
const failures: string[] = [];
if (report.attribution.accuracy < MIN_ACC) {
	failures.push(
		`encoder attribution accuracy ${report.attribution.accuracy.toFixed(3)} < SPEAKER_ISO_MIN_ACC ${MIN_ACC}`,
	);
}
if (report.attribution.margin <= 0) {
	failures.push(
		`speaker embeddings are not separable: inter-intra margin ${report.attribution.margin.toFixed(3)} ≤ 0`,
	);
}
if (report.der.der > MAX_DER) {
	failures.push(`diarizer DER ${report.der.der.toFixed(3)} > SPEAKER_ISO_MAX_DER ${MAX_DER}`);
}
if (failures.length > 0) {
	gates.fail(`${failures.length} gate failure(s):\n  - ${failures.join("\n  - ")}`);
}
log(`PASS (accuracy ≥ ${MIN_ACC}, margin > 0, DER ≤ ${MAX_DER})`);
