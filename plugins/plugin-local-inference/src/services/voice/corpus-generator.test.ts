/** Covers voice-corpus generation on both the synthetic and real-TTS paths plus ground-truth read/write. Real-TTS path exercises a live backend when present. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CORPUS_SCHEMA_VERSION,
	type CorpusTtsSynthesizer,
	generateVoiceCorpus,
	readVoiceCorpusGroundTruth,
	writeVoiceCorpus,
} from "./corpus-generator";
import type { VoiceScenario } from "./voice-scenario";
import { decodeMonoPcm16Wav } from "./wav-codec";

function scenario(): VoiceScenario {
	return {
		id: "multi-speaker-demo",
		classes: ["multi-speaker", "respond-no-respond"],
		participants: [
			{ label: "alice", entityId: "entity-alice", ttsVoiceId: "af_bella" },
			{ label: "bob", entityId: "entity-bob" },
		],
		turns: [
			{ speaker: "alice", text: "Eliza what time is it", expectRespond: true },
			{
				speaker: "bob",
				text: "no thanks alice not you",
				expectRespond: false,
				pausesMs: [300, 200],
			},
			{
				speaker: "alice",
				text: "okay set a reminder for noon",
				expectRespond: true,
				expectedEntity: "entity-alice",
			},
		],
	};
}

describe("generateVoiceCorpus (synthetic path)", () => {
	it("produces deterministic PCM + contiguous, sample-accurate labels", async () => {
		const a = await generateVoiceCorpus(scenario());
		const b = await generateVoiceCorpus(scenario());
		expect(a.pcm.length).toBe(b.pcm.length);
		expect(Array.from(a.pcm.slice(0, 64))).toEqual(
			Array.from(b.pcm.slice(0, 64)),
		);

		const gt = a.groundTruth;
		expect(gt.scenarioId).toBe("multi-speaker-demo");
		expect(gt.sampleRate).toBe(16_000);
		expect(gt.synthetic).toBe(true);
		expect(gt.turns).toHaveLength(3);
		expect(gt.totalSamples).toBe(a.pcm.length);

		// Segments tile the stream with no gaps or overlaps.
		expect(gt.turns[0].segmentStartSample).toBe(0);
		for (let i = 1; i < gt.turns.length; i++) {
			expect(gt.turns[i].segmentStartSample).toBe(
				gt.turns[i - 1].segmentEndSample,
			);
		}
		expect(gt.turns.at(-1)?.segmentEndSample).toBe(gt.totalSamples);

		// Voiced speech lies inside each turn's segment.
		for (const t of gt.turns) {
			expect(t.speechStartSample).toBeGreaterThanOrEqual(t.segmentStartSample);
			expect(t.speechEndSample).toBeLessThanOrEqual(t.segmentEndSample);
			expect(t.speechEndSample).toBeGreaterThan(t.speechStartSample);
		}
	});

	it("carries the scenario labels (speaker / respond / entity) onto the ground truth", async () => {
		const gt = (await generateVoiceCorpus(scenario())).groundTruth;
		expect(gt.turns.map((t) => t.speaker)).toEqual(["alice", "bob", "alice"]);
		expect(gt.turns.map((t) => t.expectRespond)).toEqual([true, false, true]);
		expect(gt.turns[2].expectedEntity).toBe("entity-alice");
		expect(gt.turns[0].entityId).toBe("entity-alice");
		expect(gt.turns[0].referenceTranscript).toBe("Eliza what time is it");
	});

	it("splices explicit per-turn pauses (turn.pausesMs) as silence", async () => {
		const corpus = await generateVoiceCorpus(scenario());
		const bob = corpus.groundTruth.turns[1];
		// bob's turn declares 300+200ms of trailing pause at 16kHz = 8000 samples,
		// appended AFTER the synthesized speech (which has its own short tail).
		const pauseSamples =
			Math.round((300 / 1000) * 16_000) + Math.round((200 / 1000) * 16_000);
		expect(bob.segmentEndSample - bob.speechEndSample).toBeGreaterThanOrEqual(
			pauseSamples,
		);
		// The final `pauseSamples` of bob's segment are pure silence.
		const tail = corpus.pcm.slice(
			bob.segmentEndSample - pauseSamples,
			bob.segmentEndSample,
		);
		expect(tail.every((s) => s === 0)).toBe(true);
	});

	it("sizes a long-form monologue to a long audio segment", async () => {
		const monologue = "talk about the weather. ".repeat(40).trim();
		const corpus = await generateVoiceCorpus({
			id: "long-form",
			classes: ["long-form-monologue"],
			participants: [{ label: "alice" }],
			turns: [{ speaker: "alice", text: monologue, expectRespond: true }],
		});
		// > 5 seconds of audio at 16kHz.
		expect(corpus.groundTruth.durationSec).toBeGreaterThan(5);
	});

	it("rejects an invalid scenario (fail loud)", async () => {
		await expect(
			generateVoiceCorpus({
				id: "",
				classes: [],
				participants: [],
				turns: [],
			} as unknown as VoiceScenario),
		).rejects.toThrow(/invalid scenario/);
	});

	it("rejects an audioRef-only turn (not synthesizable here)", async () => {
		await expect(
			generateVoiceCorpus({
				id: "x",
				classes: ["multi-voice"],
				participants: [{ label: "alice" }],
				turns: [
					{ speaker: "alice", audioRef: "alice-0.wav", expectRespond: true },
				],
			}),
		).rejects.toThrow(/no text to synthesize/);
	});
});

describe("generateVoiceCorpus (real-TTS path)", () => {
	it("uses an injected synthesizer and marks the corpus non-synthetic", async () => {
		const calls: Array<{ text: string; voiceId?: string }> = [];
		const synthesizer: CorpusTtsSynthesizer = {
			async synthesize({ text, voiceId, sampleRate }) {
				calls.push({ text, voiceId });
				// 0.5s of non-zero PCM.
				return new Float32Array(Math.round(0.5 * sampleRate)).fill(0.05);
			},
		};
		const corpus = await generateVoiceCorpus(scenario(), { synthesizer });
		expect(calls).toHaveLength(3);
		expect(calls[0].voiceId).toBe("af_bella"); // alice's default voice
		expect(corpus.groundTruth.synthetic).toBe(false);
		expect(corpus.groundTruth.turns.every((t) => !t.synthetic)).toBe(true);
	});
});

describe("writeVoiceCorpus / readVoiceCorpusGroundTruth", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(path.join(os.tmpdir(), "voice-corpus-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("round-trips audio + ground truth on disk", async () => {
		const corpus = await generateVoiceCorpus(scenario());
		const paths = writeVoiceCorpus(corpus, dir);
		const gt = readVoiceCorpusGroundTruth(dir);
		expect(gt?.scenarioId).toBe("multi-speaker-demo");
		expect(gt?.totalSamples).toBe(corpus.pcm.length);
		// The WAV decodes back to the same number of samples.
		const { readFileSync } = await import("node:fs");
		const decoded = decodeMonoPcm16Wav(readFileSync(paths.audioPath));
		expect(decoded.sampleRate).toBe(16_000);
		expect(decoded.pcm.length).toBe(corpus.pcm.length);
	});

	it("returns null ground truth when the corpus is absent (honesty contract)", () => {
		expect(readVoiceCorpusGroundTruth(path.join(dir, "missing"))).toBeNull();
	});

	it("stamps + round-trips the corpus schema version", async () => {
		const corpus = await generateVoiceCorpus(scenario());
		expect(corpus.groundTruth.schemaVersion).toBe(CORPUS_SCHEMA_VERSION);
		writeVoiceCorpus(corpus, dir);
		expect(readVoiceCorpusGroundTruth(dir)?.schemaVersion).toBe(
			CORPUS_SCHEMA_VERSION,
		);
	});

	it("treats a corpus written by an incompatible schema version as absent", async () => {
		const corpus = await generateVoiceCorpus(scenario());
		writeVoiceCorpus(corpus, dir);
		writeFileSync(
			path.join(dir, "ground-truth.json"),
			JSON.stringify({ ...corpus.groundTruth, schemaVersion: 999 }),
		);
		// Drifted-schema corpus reads as absent, not as a stale pass.
		expect(readVoiceCorpusGroundTruth(dir)).toBeNull();
	});
});
