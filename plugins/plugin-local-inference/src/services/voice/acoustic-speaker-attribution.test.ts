/** Covers acoustic speaker attribution: timbre-embedding extraction, online clustering, and self-voice similarity, driven by synthetic speech. Deterministic. */
import { describe, expect, it } from "vitest";
import {
	AGENT_VOICE_TIMBRE,
	makeSpeechWithSilenceFixture,
	type SpeakerTimbre,
	speakerTimbreForIndex,
} from "./__test-helpers__/synthetic-speech";
import {
	extractTimbreEmbedding,
	OnlineSpeakerClusterer,
	selfVoiceSimilarity,
} from "./acoustic-speaker-attribution";
import { scoreDiarizationTimeline } from "./e2e-harness";
import { cosineSimilarity } from "./speaker-imprint";

/**
 * The acoustic speaker attributor (#9427). These tests prove the diarization
 * gate is NO LONGER tautological: the predicted label comes from the AUDIO, so
 * it is high only when two clips really sound alike and low when they don't, and
 * the DER scorer trips on a genuine misattribution. Everything is deterministic
 * synthetic speech — no model, no network.
 */

const SR = 16_000;
function clip(
	timbre: SpeakerTimbre,
	seed: number,
	speechSec = 1,
): Float32Array {
	return makeSpeechWithSilenceFixture({
		sampleRate: SR,
		leadSilenceSec: 0.05,
		speechSec,
		tailSilenceSec: 0.05,
		seed,
		timbre,
	}).pcm;
}

describe("extractTimbreEmbedding", () => {
	it("is near-identical for two utterances of the SAME voice", () => {
		const t = speakerTimbreForIndex(0, 2);
		const a = extractTimbreEmbedding(clip(t, 1), SR);
		const b = extractTimbreEmbedding(clip(t, 999, 1.4), SR);
		expect(cosineSimilarity(a, b)).toBeGreaterThan(0.9);
	});

	it("clearly separates two DIFFERENT voices", () => {
		const a = extractTimbreEmbedding(clip(speakerTimbreForIndex(0, 2), 1), SR);
		const b = extractTimbreEmbedding(clip(speakerTimbreForIndex(1, 2), 1), SR);
		// Distinct timbres land well below the cluster threshold.
		expect(cosineSimilarity(a, b)).toBeLessThan(0.5);
	});

	it("returns a zero vector for silence", () => {
		const silent = new Float32Array(SR); // 1s of zeros
		const emb = extractTimbreEmbedding(silent, SR);
		expect(emb.every((v) => v === 0)).toBe(true);
	});

	it("is deterministic (byte-stable across calls)", () => {
		const t = speakerTimbreForIndex(1, 3);
		expect(extractTimbreEmbedding(clip(t, 7), SR)).toEqual(
			extractTimbreEmbedding(clip(t, 7), SR),
		);
	});
});

describe("OnlineSpeakerClusterer", () => {
	it("gives two distinct voices two distinct cluster ids", () => {
		const c = new OnlineSpeakerClusterer();
		const a = c.assignAudio(clip(speakerTimbreForIndex(0, 2), 1), SR);
		const b = c.assignAudio(clip(speakerTimbreForIndex(1, 2), 2), SR);
		expect(a).not.toBe(b);
	});

	it("re-uses one cluster for repeated turns of the same voice", () => {
		const c = new OnlineSpeakerClusterer();
		const t = speakerTimbreForIndex(0, 2);
		const first = c.assignAudio(clip(t, 1), SR);
		const second = c.assignAudio(clip(t, 2, 1.3), SR);
		const third = c.assignAudio(clip(t, 3, 0.8), SR);
		expect([second, third]).toEqual([first, first]);
	});

	it("tracks an A/B/A conversation as spk0/spk1/spk0", () => {
		const c = new OnlineSpeakerClusterer();
		const a = speakerTimbreForIndex(0, 2);
		const b = speakerTimbreForIndex(1, 2);
		expect([
			c.assignAudio(clip(a, 1), SR),
			c.assignAudio(clip(b, 2), SR),
			c.assignAudio(clip(a, 3), SR),
		]).toEqual(["spk0", "spk1", "spk0"]);
	});

	it("returns null for a silent turn (carries no speaker signal)", () => {
		const c = new OnlineSpeakerClusterer();
		expect(c.assignAudio(new Float32Array(SR), SR)).toBeNull();
	});
});

describe("selfVoiceSimilarity", () => {
	it("is high for the agent's own voice (an echo) and low for a person", () => {
		const echo = clip(AGENT_VOICE_TIMBRE, 4242, 1.2);
		const person = clip(speakerTimbreForIndex(0, 2), 1);
		expect(selfVoiceSimilarity(echo, SR)).toBeGreaterThan(0.9);
		expect(selfVoiceSimilarity(person, SR)).toBeLessThan(0.5);
	});

	it("is 0 for silence", () => {
		expect(selfVoiceSimilarity(new Float32Array(SR), SR)).toBe(0);
	});
});

describe("DER gate is no longer tautological (#9427)", () => {
	const a = speakerTimbreForIndex(0, 2);
	const b = speakerTimbreForIndex(1, 2);

	it("PASSES (DER 0) when the clusterer attributes two voices correctly", () => {
		const c = new OnlineSpeakerClusterer();
		const turns = [
			{ expectedLabel: "alice", startMs: 0, endMs: 1000 },
			{ expectedLabel: "bob", startMs: 1000, endMs: 2000 },
			{ expectedLabel: "alice", startMs: 2000, endMs: 3000 },
		];
		const audio = [clip(a, 1), clip(b, 2), clip(a, 3)];
		const scored = scoreDiarizationTimeline(
			turns.map((t, i) => ({
				...t,
				predictedLabel: c.assignAudio(audio[i], SR),
			})),
			{ maxDer: 0.2 },
		);
		expect(scored.der).toBe(0);
		expect(scored.passed).toBe(true);
	});

	it("FAILS when two distinct speakers are acoustically merged", () => {
		// Ground truth says alice then bob, but the SECOND turn's audio is also
		// alice's voice — the blind clusterer (correctly) merges them, so the DER
		// gate trips. A tautological gate (predicted = ground-truth label) could
		// never catch this; this is exactly the defect #9427 closes.
		const c = new OnlineSpeakerClusterer();
		const scored = scoreDiarizationTimeline(
			[
				{
					expectedLabel: "alice",
					predictedLabel: c.assignAudio(clip(a, 1), SR),
					startMs: 0,
					endMs: 1000,
				},
				{
					expectedLabel: "bob",
					predictedLabel: c.assignAudio(clip(a, 2), SR), // alice's voice again
					startMs: 1000,
					endMs: 2000,
				},
			],
			{ maxDer: 0.2 },
		);
		expect(scored.der).toBeGreaterThan(0.2);
		expect(scored.passed).toBe(false);
	});
});
