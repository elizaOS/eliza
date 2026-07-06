/**
 * Domain evidence for #12256: drives the synthetic echo corpus through the REAL
 * production echo defense — the NlmsEchoCanceller, the desktop FarEndReference
 * (whole-utterance align + cancel), and an MFCC-embedding AgentSelfVoiceImprint
 * — and prints the ERLE + self-voice-rejection numbers against the #12258
 * workbench ceilings (minErleDb 18). No models, no network, no device: the DSP
 * is real, the speech is deterministic synthesis (synthetic-speech.ts +
 * corpus-augment.ts). Writes a JSON report for the PR evidence bundle.
 *
 *   bun run scripts/echo-aec-evidence.ts [--json <path>]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { computeErle, computeFarActiveErle } from "@elizaos/shared/voice/aec";
import {
	AGENT_VOICE_TIMBRE,
	makeSpeechWithSilenceFixture,
	speakerTimbreForIndex,
} from "../src/services/voice/__test-helpers__/synthetic-speech.js";
import { extractTimbreEmbedding } from "../src/services/voice/acoustic-speaker-attribution.js";
import { applyGainDb, applyReverb } from "../src/services/voice/corpus-augment.js";
import {
	cancelEchoInWavUtterance,
	FarEndReference,
} from "../src/services/voice/far-end-reference.js";
import { AgentSelfVoiceImprint } from "../src/services/voice/self-voice-imprint.js";
import type { SpeakerEncoder } from "../src/services/voice/speaker/encoder.js";
import { NlmsEchoCanceller } from "../src/services/voice/nlms-echo-canceller.js";
import { encodeMonoPcm16Wav } from "../src/services/voice/wav-codec.js";

const SR = 16_000;
const MIN_ERLE_DB = 18; // #12258 desktop-aec ceiling.

/** The agent's rendered TTS for a turn (its own synthetic voice). */
function agentTts(seed: number, sec = 1.6): Float32Array {
	return makeSpeechWithSilenceFixture({
		sampleRate: SR,
		leadSilenceSec: 0.05,
		speechSec: sec,
		tailSilenceSec: 0.05,
		seed,
		timbre: AGENT_VOICE_TIMBRE,
	}).pcm;
}

/** A human turn (a scenario participant's voice, acoustically distinct). */
function humanTurn(seed: number, index: number, sec = 1.6): Float32Array {
	return makeSpeechWithSilenceFixture({
		sampleRate: SR,
		leadSilenceSec: 0.05,
		speechSec: sec,
		tailSilenceSec: 0.05,
		seed,
		timbre: speakerTimbreForIndex(index, 4),
	}).pcm;
}

/**
 * The agent's playback as it returns through the room into the mic: a bulk
 * transport delay + far-field attenuation, plus an optional SHORT room impulse
 * (a few early reflections within the 256-tap / 16 ms adaptive span — a longer
 * reverb tail is AEC3-class work and out of the NLMS filter's reach). `near`
 * has `far` starting at `delaySamples`; index 0..delay is pre-echo silence.
 */
function roomEcho(
	far: Float32Array,
	delaySamples: number,
	farFieldDb: number,
	earlyReflections: ReadonlyArray<readonly [number, number]> = [],
): Float32Array {
	const attenuated = applyGainDb(far, -Math.abs(farFieldDb));
	const near = new Float32Array(far.length + delaySamples + 512);
	// Direct echo path.
	for (let i = 0; i < attenuated.length; i++) near[delaySamples + i] += attenuated[i];
	// A few early reflections (tapDelaySamples, gain) within the filter span.
	for (const [tap, gain] of earlyReflections) {
		for (let i = 0; i < attenuated.length; i++) {
			near[delaySamples + tap + i] += attenuated[i] * gain;
		}
	}
	return near;
}

/** Far-end reference aligned sample-for-sample to `near` (far starts at
 * `delaySamples`), for far-active ERLE masking. */
function alignedReference(far: Float32Array, nearLen: number, delaySamples: number): Float32Array {
	const aligned = new Float32Array(nearLen);
	for (let i = 0; i < far.length && delaySamples + i < nearLen; i++) {
		aligned[delaySamples + i] = far[i];
	}
	return aligned;
}

/**
 * Direct per-utterance NLMS ERLE (echo-only). The canceller pre-delays the raw
 * `far` reference by `delaySamples` itself, so we pass raw `far` (NOT a shifted
 * copy) — pre-shifting AND setting delaySamples would double the delay. A warm
 * pass converges the adaptive filter before the measured pass.
 */
function directNlmsErle(
	far: Float32Array,
	delaySamples: number,
	farFieldDb: number,
	earlyReflections: ReadonlyArray<readonly [number, number]>,
): { erleDb: number; farActiveErleDb: number | null } {
	const near = roomEcho(far, delaySamples, farFieldDb, earlyReflections);
	const reference = new Float32Array(near.length);
	reference.set(far.subarray(0, Math.min(far.length, near.length)));
	const canceller = new NlmsEchoCanceller({ delaySamples });
	canceller.process(near, reference); // warm the adaptive filter
	const residual = canceller.process(near, reference); // measured (converged)
	const aligned = alignedReference(far, near.length, delaySamples);
	const masked = computeFarActiveErle(near, residual, aligned);
	return { erleDb: computeErle(near, residual), farActiveErleDb: masked.erleDb };
}

/** An MFCC-timbre SpeakerEncoder — the real acoustic embedding, encoder-free
 * (no fused WeSpeaker GGUF in this worktree; labelled honestly in the report). */
const mfccEncoder: SpeakerEncoder = {
	embeddingDim: 13,
	sampleRate: SR,
	async encode(pcm: Float32Array): Promise<Float32Array> {
		return Float32Array.from(extractTimbreEmbedding(pcm, SR));
	},
};

async function main(): Promise<void> {
	const report: Record<string, unknown> = {
		generatedAt: new Date().toISOString(),
		minErleDbCeiling: MIN_ERLE_DB,
		note:
			"Real NlmsEchoCanceller + FarEndReference + MFCC AgentSelfVoiceImprint over the deterministic synthetic echo corpus. The fused WeSpeaker GGUF is unstaged in this worktree, so the embedding encoder is MFCC-timbre (13d); real-hardware ERLE (device-acoustic-erle.mjs) is N/A without a loaded acoustic host.",
	};

	// ── 1. Direct NLMS ERLE across echo conditions ─────────────────────────
	// Early reflections are [tapSamples, gain] within the 256-tap span.
	const conditions = [
		{ name: "clean-echo", delayMs: 20, farFieldDb: 6, reflections: [] as ReadonlyArray<readonly [number, number]> },
		{ name: "early-reflections", delayMs: 45, farFieldDb: 9, reflections: [[64, 0.35], [150, 0.18]] as ReadonlyArray<readonly [number, number]> },
		{ name: "long-transport", delayMs: 380, farFieldDb: 9, reflections: [[80, 0.3]] as ReadonlyArray<readonly [number, number]> },
	];
	const nlms = conditions.map((c) => {
		const far = agentTts(0x1000 + Math.round(c.delayMs));
		const { erleDb, farActiveErleDb } = directNlmsErle(
			far,
			Math.round((c.delayMs / 1000) * SR),
			c.farFieldDb,
			c.reflections,
		);
		return {
			condition: c.name,
			delayMs: c.delayMs,
			farFieldDb: c.farFieldDb,
			earlyReflections: c.reflections,
			erleDb: Number(erleDb.toFixed(2)),
			farActiveErleDb:
				farActiveErleDb === null ? null : Number(farActiveErleDb.toFixed(2)),
			meetsCeiling: (farActiveErleDb ?? erleDb) >= MIN_ERLE_DB,
		};
	});
	report.directNlms = nlms;

	// ── 2. Desktop FarEndReference end-to-end (align + cancel a WAV) ────────
	const far = agentTts(0x2222, 2.4);
	const farEnd = new FarEndReference();
	const baseTs = 5_000;
	const epoch = 1_000_000;
	// Deliver the playback as timestamped renderer frames (20 ms), as the pump does.
	const frameSamples = 320;
	for (let i = 0; (i + 1) * frameSamples <= far.length; i += 1) {
		const framePcm = far.subarray(i * frameSamples, (i + 1) * frameSamples);
		const bytes = Buffer.alloc(frameSamples * 2);
		for (let k = 0; k < frameSamples; k++) {
			bytes.writeInt16LE(
				Math.round(Math.max(-1, Math.min(1, framePcm[k])) * 32767),
				k * 2,
			);
		}
		farEnd.pushPlayback(
			[
				{
					pcm16: bytes.toString("base64"),
					sampleRate: SR,
					channels: 1,
					samples: frameSamples,
					rms: 0.1,
					timestamp: baseTs + i * 20,
					frameIndex: i,
				},
			],
			baseTs + i * 20 + epoch + 5,
		);
	}
	farEnd.notePlaybackReset(); // the pump resets before the echoed WAV arrives
	// The mic hears the far playback delayed 60 ms + far-field + early reflections.
	const delaySamples = Math.round(0.06 * SR);
	const nearFull = roomEcho(far, delaySamples, 10, [
		[70, 0.3],
		[160, 0.15],
	]);
	const nearWav = encodeMonoPcm16Wav(nearFull, SR);
	const nearEndTs = baseTs + (nearFull.length / SR) * 1000;
	const outcome = cancelEchoInWavUtterance(
		farEnd,
		nearWav,
		nearEndTs + epoch + 15,
	);
	report.desktopFarEndReference = {
		applied: outcome.result?.applied ?? false,
		reason: outcome.result?.reason ?? null,
		erleDb:
			outcome.result?.erleDb == null
				? null
				: Number(outcome.result.erleDb.toFixed(2)),
		offsetSamples: outcome.result?.offsetSamples ?? null,
		confidence:
			outcome.result?.confidence == null
				? null
				: Number(outcome.result.confidence.toFixed(3)),
		farActiveSamples: outcome.result?.farActiveSamples ?? 0,
		meetsCeiling: (outcome.result?.erleDb ?? 0) >= MIN_ERLE_DB,
		status: farEnd.status(),
	};

	// ── 3. Self-voice imprint: agent rejected, humans passed ────────────────
	// NOTE on thresholds: the imprint's 0.28 default is calibrated for the fused
	// WeSpeaker embedding (self ~0.37 vs human ~0.15, §6) — unstaged here. The
	// deterministic MFCC-timbre-13d proxy encoder sits on a DIFFERENT scale
	// (same-timbre ~1.0), so the honest operating point for THIS encoder is the
	// workbench's MFCC bar (0.7), not 0.28. The gate LOGIC is identical; only the
	// per-encoder threshold differs — which is exactly why `selfVoiceThreshold`
	// travels with the measurement. We report separation at the MFCC operating
	// point AND cite the production WeSpeaker margins from §6.
	const MFCC_THRESHOLD = 0.7;
	const imprint = new AgentSelfVoiceImprint({
		encoder: mfccEncoder,
		minSamples: SR,
		similarityThreshold: MFCC_THRESHOLD,
	});
	// Enroll the imprint from many agent utterances (a centroid, not one clip).
	for (let i = 0; i < 8; i++) {
		await imprint.observeAudio(agentTts(0x3000 + i, 1.6), SR);
	}
	const agentProbes = [] as { seed: number; similarity: number; rejected: boolean | null }[];
	for (let i = 0; i < 5; i++) {
		const emb = await mfccEncoder.encode(agentTts(0x4000 + i, 1.6));
		const similarity = await imprint.similarity(emb);
		agentProbes.push({
			seed: 0x4000 + i,
			similarity: similarity === null ? Number.NaN : Number(similarity.toFixed(3)),
			rejected: await imprint.isAgentSelfVoice(emb),
		});
	}
	const humanProbes = [] as { seed: number; index: number; similarity: number; rejected: boolean | null }[];
	for (let i = 0; i < 4; i++) {
		const emb = await mfccEncoder.encode(humanTurn(0x5000 + i, i, 1.6));
		const similarity = await imprint.similarity(emb);
		humanProbes.push({
			seed: 0x5000 + i,
			index: i,
			similarity: similarity === null ? Number.NaN : Number(similarity.toFixed(3)),
			rejected: await imprint.isAgentSelfVoice(emb),
		});
	}
	const agentSelfMean =
		agentProbes.reduce((s, p) => s + p.similarity, 0) / agentProbes.length;
	const humanMean =
		humanProbes.reduce((s, p) => s + p.similarity, 0) / humanProbes.length;
	report.selfVoiceImprint = {
		mfccOperatingThreshold: MFCC_THRESHOLD,
		productionWeSpeakerThreshold: 0.28,
		productionMarginsFromAssessmentSection6: { agentSelf: 0.37, human: 0.15 },
		encoder: "mfcc-timbre-13d (fused WeSpeaker GGUF unstaged in this worktree)",
		agentSelfSimilarityMean: Number(agentSelfMean.toFixed(3)),
		humanSimilarityMean: Number(humanMean.toFixed(3)),
		humanSimilarityMax: Number(
			Math.max(...humanProbes.map((p) => p.similarity)).toFixed(3),
		),
		allAgentRejected: agentProbes.every((p) => p.rejected === true),
		allHumanPassed: humanProbes.every((p) => p.rejected === false),
		agentProbes,
		humanProbes,
	};

	// ── verdict ─────────────────────────────────────────────────────────────
	const nlmsPass = nlms.every((n) => n.meetsCeiling);
	const desktopPass =
		(report.desktopFarEndReference as { meetsCeiling: boolean }).meetsCeiling;
	const selfVoicePass =
		(report.selfVoiceImprint as { allAgentRejected: boolean; allHumanPassed: boolean }).allAgentRejected &&
		(report.selfVoiceImprint as { allHumanPassed: boolean }).allHumanPassed;
	report.verdict = nlmsPass && desktopPass && selfVoicePass ? "PASS" : "FAIL";

	// ── print ────────────────────────────────────────────────────────────────
	console.log("=== #12256 echo/AEC domain evidence (real DSP over synthetic corpus) ===\n");
	console.log("Direct NLMS ERLE (ceiling: minErleDb 18):");
	for (const n of nlms) {
		console.log(
			`  ${n.condition.padEnd(18)} delay=${n.delayMs}ms farField=${n.farFieldDb}dB reflections=${n.earlyReflections.length}  ERLE=${n.erleDb}dB  far-active=${n.farActiveErleDb}dB  ${n.meetsCeiling ? "PASS" : "FAIL"}`,
		);
	}
	const d = report.desktopFarEndReference as {
		applied: boolean;
		erleDb: number | null;
		confidence: number | null;
		offsetSamples: number | null;
		meetsCeiling: boolean;
	};
	console.log(
		`\nDesktop FarEndReference (whole-utterance align+cancel): applied=${d.applied} ERLE=${d.erleDb}dB confidence=${d.confidence} offset=${d.offsetSamples}samples  ${d.meetsCeiling ? "PASS" : "FAIL"}`,
	);
	const s = report.selfVoiceImprint as {
		mfccOperatingThreshold: number;
		productionWeSpeakerThreshold: number;
		agentSelfSimilarityMean: number;
		humanSimilarityMean: number;
		humanSimilarityMax: number;
		allAgentRejected: boolean;
		allHumanPassed: boolean;
	};
	console.log(
		`\nSelf-voice imprint (MFCC proxy threshold ${s.mfccOperatingThreshold}; production WeSpeaker ${s.productionWeSpeakerThreshold}):`,
	);
	console.log(
		`  agent-self mean=${s.agentSelfSimilarityMean}  human mean=${s.humanSimilarityMean} (max ${s.humanSimilarityMax})`,
	);
	console.log(
		`  all agent echoes rejected: ${s.allAgentRejected}   all humans passed: ${s.allHumanPassed}`,
	);
	console.log(`\nVERDICT: ${report.verdict}\n`);

	const jsonFlag = process.argv.indexOf("--json");
	const jsonPath =
		jsonFlag >= 0 && process.argv[jsonFlag + 1]
			? process.argv[jsonFlag + 1]
			: path.join(
					process.cwd(),
					"..",
					"..",
					"test-results", "evidence",
					"12256-echo",
					"echo-aec-evidence.json",
				);
	mkdirSync(path.dirname(jsonPath), { recursive: true });
	writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
	console.log(`Report written: ${jsonPath}`);
	if (report.verdict !== "PASS") process.exitCode = 1;
}

void main();
