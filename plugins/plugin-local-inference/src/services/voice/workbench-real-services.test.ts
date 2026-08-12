/**
 * Deterministic coverage for real workbench enrollment and stream adapters.
 * Native TTS, pyannote, and WeSpeaker calls are injected so profile centroids,
 * window coverage, offsets, overlap, and blind clustering are exercised
 * without model artifacts.
 */

import { describe, expect, it } from "vitest";
import { fakeFfi } from "./__test-helpers__/fake-ffi";
import {
	cosineSimilarity,
	DEFAULT_VOICE_IMPRINT_MATCH_THRESHOLD,
} from "./speaker-imprint";
import {
	buildVoiceWorkbenchEnrollmentCentroid,
	diarizeVoiceWorkbenchStream,
	resolveElevenLabsWorkbenchVoiceId,
	transcribeVoiceWorkbenchStream,
	VOICE_WORKBENCH_ENROLLMENT_PHRASES,
	VOICE_WORKBENCH_OWNER_THRESHOLD,
} from "./workbench-real-services";
import { VOICE_WORKBENCH_SCENARIOS } from "./workbench-scenarios";
import { validateScenarioVoiceAssignments } from "./workbench-voice-packs";

const SAMPLE_RATE = 16_000;
const WINDOW_SAMPLES = SAMPLE_RATE * 5;

describe("buildVoiceWorkbenchEnrollmentCentroid", () => {
	it("uses fixed held-out phrases with one validated pack", async () => {
		const calls: Array<{ text: string; voiceId: string }> = [];
		const centroid = await buildVoiceWorkbenchEnrollmentCentroid({
			voiceId: "bm_lewis",
			async synthesize(input) {
				calls.push(input);
				return new Float32Array([calls.length]);
			},
			async encode() {
				return new Float32Array([1, 0, 0]);
			},
		});

		expect(calls).toEqual(
			VOICE_WORKBENCH_ENROLLMENT_PHRASES.map((text) => ({
				text,
				voiceId: "bm_lewis",
			})),
		);
		expect(new Set(calls.map((call) => call.text)).size).toBe(calls.length);
		expect(centroid).toEqual(new Float32Array([1, 0, 0]));
	});

	it("keeps enrollment content disjoint from every scored turn", () => {
		const scoredTurnTexts = VOICE_WORKBENCH_SCENARIOS.flatMap((scenario) =>
			scenario.turns.map((turn) => turn.text.trim().toLowerCase()),
		);
		for (const phrase of VOICE_WORKBENCH_ENROLLMENT_PHRASES) {
			const normalized = phrase.trim().toLowerCase();
			expect(scoredTurnTexts).not.toContain(normalized);
			expect(
				scoredTurnTexts.some(
					(turn) => turn.includes(normalized) || normalized.includes(turn),
				),
			).toBe(false);
		}
	});

	it("averages nuisance variation while preserving the fixed impostor gate", async () => {
		const nuisance = Math.sqrt(1 - 0.75 ** 2);
		const samples = [
			new Float32Array([0.75, nuisance, 0]),
			new Float32Array([0.75, -nuisance, 0]),
			new Float32Array([1, 0, 0]),
		];
		let encodeIndex = 0;
		const centroid = await buildVoiceWorkbenchEnrollmentCentroid({
			voiceId: "bm_lewis",
			async synthesize() {
				return new Float32Array([1]);
			},
			async encode() {
				const embedding = samples[encodeIndex];
				if (!embedding) throw new Error("unexpected enrollment encode");
				encodeIndex += 1;
				return embedding;
			},
		});

		const genuine = new Float32Array([1, 0, 0]);
		const impostor = new Float32Array([0, 0, 1]);
		const singleSampleSimilarity = cosineSimilarity(samples[0], genuine);
		const centroidSimilarity = cosineSimilarity(centroid, genuine);
		const centroidNorm = Math.hypot(...centroid);

		expect(VOICE_WORKBENCH_OWNER_THRESHOLD).toBe(
			DEFAULT_VOICE_IMPRINT_MATCH_THRESHOLD,
		);
		expect(VOICE_WORKBENCH_OWNER_THRESHOLD).toBe(0.78);
		expect(centroidNorm).toBeCloseTo(1, 6);
		expect(singleSampleSimilarity).toBeLessThan(
			VOICE_WORKBENCH_OWNER_THRESHOLD,
		);
		expect(centroidSimilarity).toBeGreaterThan(VOICE_WORKBENCH_OWNER_THRESHOLD);
		expect(centroidSimilarity).toBeGreaterThan(singleSampleSimilarity);
		expect(cosineSimilarity(centroid, impostor)).toBeLessThan(
			VOICE_WORKBENCH_OWNER_THRESHOLD,
		);
	});

	it("fails closed when any enrollment sample cannot be encoded", async () => {
		let synthesizeCalls = 0;
		let encodeCalls = 0;
		await expect(
			buildVoiceWorkbenchEnrollmentCentroid({
				voiceId: "bm_lewis",
				async synthesize() {
					synthesizeCalls += 1;
					return new Float32Array([1]);
				},
				async encode() {
					encodeCalls += 1;
					if (encodeCalls === 2) {
						throw new Error("speaker encoder rejected sample");
					}
					return new Float32Array([1, 0, 0]);
				},
			}),
		).rejects.toThrow("speaker encoder rejected sample");
		expect(synthesizeCalls).toBe(2);
		expect(encodeCalls).toBe(2);
	});
});

describe("ElevenLabs workbench voice assignments", () => {
	it("keeps every built-in scenario participant acoustically distinct", () => {
		for (const scenario of VOICE_WORKBENCH_SCENARIOS) {
			const validation = validateScenarioVoiceAssignments(
				scenario,
				resolveElevenLabsWorkbenchVoiceId,
			);
			expect(validation.errors, scenario.id).toEqual([]);
			expect(
				new Set(validation.assignments.map((entry) => entry.resolvedVoiceId))
					.size,
				scenario.id,
			).toBe(scenario.participants.length);
		}
	});
});

describe("diarizeVoiceWorkbenchStream", () => {
	it("processes every five-second window and keeps stream-relative boundaries", async () => {
		const calls: Float32Array[] = [];
		const observations = await diarizeVoiceWorkbenchStream({
			audio: new Float32Array(SAMPLE_RATE * 11),
			sampleRate: SAMPLE_RATE,
			async diarizeWindow(pcm) {
				calls.push(pcm);
				return {
					segments: [
						{
							startMs: 100,
							endMs: 4_900,
							localSpeakerId: 0,
							confidence: 0.9,
							hasOverlap: false,
						},
					],
					localSpeakerCount: 1,
					speechMs: 4_800,
				};
			},
			async encodeSpeaker() {
				return new Float32Array([1, 0]);
			},
		});

		expect(calls).toHaveLength(3);
		expect(calls.every((pcm) => pcm.length === WINDOW_SAMPLES)).toBe(true);
		expect(observations).toEqual([
			{
				speaker: "spk0",
				startMs: 100,
				endMs: 4_900,
				confidence: 0.9,
				hasOverlap: false,
			},
			{
				speaker: "spk0",
				startMs: 5_100,
				endMs: 9_900,
				confidence: 0.9,
				hasOverlap: false,
			},
			{
				speaker: "spk0",
				startMs: 10_100,
				endMs: 11_000,
				confidence: 0.9,
				hasOverlap: false,
			},
		]);
	});

	it("preserves simultaneous local-speaker segments as overlapping clusters", async () => {
		let embedding = 0;
		const observations = await diarizeVoiceWorkbenchStream({
			audio: new Float32Array(WINDOW_SAMPLES),
			sampleRate: SAMPLE_RATE,
			async diarizeWindow() {
				return {
					segments: [0, 1].map((localSpeakerId) => ({
						startMs: 1_000,
						endMs: 2_000,
						localSpeakerId,
						confidence: 0.8,
						hasOverlap: true,
					})),
					localSpeakerCount: 2,
					speechMs: 1_000,
				};
			},
			async encodeSpeaker() {
				embedding += 1;
				return embedding === 1
					? new Float32Array([1, 0])
					: new Float32Array([-1, 0]);
			},
		});

		expect(observations).toMatchObject([
			{ speaker: "spk0", startMs: 1_000, endMs: 2_000, hasOverlap: true },
			{ speaker: "spk1", startMs: 1_000, endMs: 2_000, hasOverlap: true },
		]);
	});
});

describe("transcribeVoiceWorkbenchStream", () => {
	it("uses the fused-batch interim path when native streaming is unsupported", async () => {
		let batchCalls = 0;
		const ffi = {
			...fakeFfi("hey Eliza check the weather"),
			asrTranscribe: () => {
				batchCalls += 1;
				return "hey Eliza check the weather";
			},
			asrStreamOpen: () => {
				throw new Error("native streaming path must not open");
			},
		};

		const result = await transcribeVoiceWorkbenchStream({
			ffi,
			ctx: 1n,
			pcm: new Float32Array(SAMPLE_RATE * 3).fill(0.05),
		});

		expect(batchCalls).toBeGreaterThanOrEqual(3);
		expect(result.transcript).toBe("hey Eliza check the weather");
		expect(result.partials).toContain("hey Eliza check the weather");
	});

	it("keeps the native streaming path when the fused runtime advertises it", async () => {
		let streamFeeds = 0;
		const base = fakeFfi("hello from streaming", {
			asrStreamSupported: true,
		});
		const ffi = {
			...base,
			asrTranscribe: () => {
				throw new Error("batch path must not run");
			},
			asrStreamFeed: () => {
				streamFeeds += 1;
			},
		};

		const result = await transcribeVoiceWorkbenchStream({
			ffi,
			ctx: 1n,
			pcm: new Float32Array(SAMPLE_RATE).fill(0.05),
		});

		expect(streamFeeds).toBe(5);
		expect(result.transcript).toBe("hello from streaming");
		expect(result.partials).toContain("hello from streaming");
	});
});
