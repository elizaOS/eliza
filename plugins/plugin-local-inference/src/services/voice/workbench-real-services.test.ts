/**
 * Deterministic coverage for the real workbench stream diarization adapter.
 * Native pyannote and WeSpeaker calls are injected so window coverage, stream
 * offsets, final-window clipping, overlap, and blind clustering are exercised
 * without model artifacts.
 */

import { describe, expect, it } from "vitest";
import { diarizeVoiceWorkbenchStream } from "./workbench-real-services";

const SAMPLE_RATE = 16_000;
const WINDOW_SAMPLES = SAMPLE_RATE * 5;

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
