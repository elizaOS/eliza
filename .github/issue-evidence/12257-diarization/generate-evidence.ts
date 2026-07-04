#!/usr/bin/env bun
/**
 * Domain-artifact evidence generator for #12257. Drives the synthetic
 * multi-speaker corpus through the REAL VoiceProfileStore + REAL MFCC-style
 * `extractTimbreEmbedding` DSP encoder + the REAL windowed attribution
 * pipeline — producing genuine `vp_*.json` speaker profiles on disk and the
 * attribution output for a two-speaker run.
 *
 * The native WeSpeaker + pyannote GGUF forward passes are NOT exercised here:
 * `ELIZA_TEST_SPEAKER_GGUF` / `ELIZA_TEST_DIARIZ_GGUF` and the fused library are
 * unstaged in this worktree (the `--real` workbench lane hard-fails, proving no
 * false-pass). Everything else — the store, disk records, cross-turn
 * re-identification, and the 5 s windowing bookkeeping — is real.
 *
 * Run: bun .github/issue-evidence/12257-diarization/generate-evidence.ts
 */

import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractTimbreEmbedding } from "../../../plugins/plugin-local-inference/src/services/voice/acoustic-speaker-attribution.ts";
import { makeSpeechWithSilenceFixture, speakerTimbreForIndex } from "../../../plugins/plugin-local-inference/src/services/voice/__test-helpers__/synthetic-speech.ts";
import { VoiceProfileStore } from "../../../plugins/plugin-local-inference/src/services/voice/profile-store.ts";
import type { SpeakerEncoder } from "../../../plugins/plugin-local-inference/src/services/voice/speaker/encoder.ts";
import { VoiceAttributionPipeline } from "../../../plugins/plugin-local-inference/src/services/voice/speaker/attribution-pipeline.ts";

const SR = 16_000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = path.join(HERE, "voice-profiles");
const MODEL = "mfcc-timbre-13d";

/** Real DSP encoder: 13-d MFCC timbre embedding over the turn's PCM. */
const encoder: SpeakerEncoder = {
	embeddingDim: 13,
	sampleRate: SR,
	modelId: MODEL,
	async encode(pcm) {
		return Float32Array.from(extractTimbreEmbedding(pcm, SR));
	},
	async dispose() {},
};

/** Voiced PCM of `seconds` for speaker `idx` of 2, no leading/trailing silence. */
function speakerPcm(idx: number, seconds: number): Float32Array {
	const fixture = makeSpeechWithSilenceFixture({
		sampleRate: SR,
		leadSilenceSec: 0,
		speechSec: seconds,
		tailSilenceSec: 0,
		seed: 0x1000 + idx,
		timbre: speakerTimbreForIndex(idx, 2),
	});
	return fixture.pcm;
}

async function main(): Promise<void> {
	rmSync(PROFILES_DIR, { recursive: true, force: true });
	const store = new VoiceProfileStore({ rootDir: PROFILES_DIR });
	await store.init();
	const pipeline = new VoiceAttributionPipeline({ encoder, profileStore: store });

	const turns: Array<Record<string, unknown>> = [];

	// Turn 1 — speaker A, short one-shot turn → new profile.
	const a1 = await pipeline.attribute({
		turnId: "A-1",
		pcm: speakerPcm(0, 3),
		startedAtMs: 0,
		endedAtMs: 3_000,
	});
	turns.push({
		turn: "A-1 (speaker A, 3s one-shot)",
		profileId: a1.observation?.profileId,
		clusterId: a1.observation?.imprintClusterId,
		newCluster: a1.primarySpeaker?.metadata?.attributionOnly === true,
	});

	// Turn 2 — speaker B, short one-shot turn → distinct profile.
	const b1 = await pipeline.attribute({
		turnId: "B-1",
		pcm: speakerPcm(1, 3),
		startedAtMs: 0,
		endedAtMs: 3_000,
	});
	turns.push({
		turn: "B-1 (speaker B, 3s one-shot)",
		profileId: b1.observation?.profileId,
		clusterId: b1.observation?.imprintClusterId,
		distinctFromA: b1.observation?.profileId !== a1.observation?.profileId,
	});

	// Turn 3 — speaker A again, LONG 14s turn via the windowed path.
	// Two 5s windows decode during capture; the trailing 4s at finalize.
	const attributor = pipeline.beginTurn({ turnId: "A-2-long", startedAtMs: 0 });
	const fullPcm = speakerPcm(0, 14);
	await attributor.pushWindow(fullPcm.subarray(0, 5 * SR), 0);
	await attributor.pushWindow(fullPcm.subarray(5 * SR, 10 * SR), 5_000);
	const speculative = await attributor.speculativeMatch.result;
	const a2 = await attributor.finalize({
		fullPcm,
		finalWindowPcm: fullPcm.subarray(10 * SR),
		finalWindowStartMs: 10_000,
		endedAtMs: 14_000,
	});
	turns.push({
		turn: "A-2 (speaker A, 14s WINDOWED)",
		windowsDiarizedDuringCapture: attributor.windowsDiarized,
		postEndpointWindowSeconds: (fullPcm.length - 10 * SR) / SR,
		speechStartSpeculativeMatch: speculative?.profile.id ?? null,
		profileId: a2.observation?.profileId,
		reidentifiedAsSpeakerA: a2.observation?.profileId === a1.observation?.profileId,
	});

	const profiles = await store.list();
	const evidence = {
		issue: 12257,
		generatedAt: new Date().toISOString(),
		encoder: `${MODEL} (real MFCC DSP; WeSpeaker GGUF unstaged in worktree)`,
		profilesDir: path.relative(path.join(HERE, "..", "..", ".."), PROFILES_DIR),
		turns,
		diskProfiles: profiles.map((p) => ({
			profileId: p.profileId,
			sampleCount: p.sampleCount,
			totalDurationMs: p.totalDurationMs,
			embeddingModel: p.embeddingModel,
			embeddingDim: p.embeddingDim,
		})),
	};
	writeFileSync(
		path.join(HERE, "synthetic-multispeaker-attribution.json"),
		`${JSON.stringify(evidence, null, 2)}\n`,
	);
	process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
	process.stdout.write(
		`\n${profiles.length} profile(s) written under ${PROFILES_DIR}\n`,
	);
}

main().catch((err: unknown) => {
	process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
