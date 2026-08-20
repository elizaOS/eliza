/**
 * Deterministic coverage for the real workbench measurement adapters: stream
 * diarization, streaming ASR selection, ERLE echo replay, and the barge-in
 * playback-stop probe. Native pyannote/WeSpeaker/Kokoro calls are injected so
 * window coverage, stream offsets, blind clustering, canceller replay, and
 * cancel-latency semantics are exercised without model artifacts.
 */

import { describe, expect, it } from "vitest";
import { fakeFfi } from "./__test-helpers__/fake-ffi";
import {
	diarizeVoiceWorkbenchStream,
	measureBargeInPlaybackStopMs,
	measureEchoTurnErle,
	transcribeVoiceWorkbenchStream,
} from "./workbench-real-services";

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

describe("measureEchoTurnErle", () => {
	function noiseSignal(samples: number, seed: number): Float32Array {
		const out = new Float32Array(samples);
		let state = seed >>> 0;
		for (let i = 0; i < samples; i++) {
			state = (state * 1664525 + 1013904223) >>> 0;
			out[i] = (state / 0xffffffff) * 0.6 - 0.3;
		}
		return out;
	}

	it("cancels a pure linear echo well above the 18 dB floor", () => {
		const far = noiseSignal(SAMPLE_RATE * 2, 7);
		const near = new Float32Array(far.length);
		for (let i = 0; i < far.length; i++) near[i] = far[i] * 0.5;
		const erleDb = measureEchoTurnErle({ near, farReference: far });
		expect(erleDb).not.toBeNull();
		expect(erleDb as number).toBeGreaterThan(18);
	});

	it("still measures when the near end carries environmental noise", () => {
		const far = noiseSignal(SAMPLE_RATE * 2, 7);
		const hiss = noiseSignal(far.length, 99);
		const near = new Float32Array(far.length);
		for (let i = 0; i < far.length; i++) {
			near[i] = far[i] * 0.5 + hiss[i] * 0.01;
		}
		const erleDb = measureEchoTurnErle({ near, farReference: far });
		expect(erleDb).not.toBeNull();
		expect(Number.isFinite(erleDb as number)).toBe(true);
		expect(erleDb as number).toBeGreaterThan(6);
	});

	it("pads a shorter far-end reference instead of truncating the near end", () => {
		const far = noiseSignal(SAMPLE_RATE, 7);
		const near = new Float32Array(SAMPLE_RATE * 2);
		for (let i = 0; i < far.length; i++) near[i] = far[i] * 0.5;
		const erleDb = measureEchoTurnErle({ near, farReference: far });
		expect(erleDb).not.toBeNull();
	});

	it("returns null for an empty or silent window instead of fabricating dB", () => {
		expect(
			measureEchoTurnErle({
				near: new Float32Array(0),
				farReference: new Float32Array(SAMPLE_RATE),
			}),
		).toBeNull();
		expect(
			measureEchoTurnErle({
				near: new Float32Array(SAMPLE_RATE),
				farReference: new Float32Array(0),
			}),
		).toBeNull();
		// A silent far end has no far-active block — no echo, no measurement.
		expect(
			measureEchoTurnErle({
				near: new Float32Array(SAMPLE_RATE).fill(0.1),
				farReference: new Float32Array(SAMPLE_RATE),
			}),
		).toBeNull();
	});
});

describe("measureBargeInPlaybackStopMs", () => {
	it("reports the latency from cancel request to stream return", async () => {
		const cancelMs = await measureBargeInPlaybackStopMs(
			async ({ cancelSignal, onChunk }) => {
				for (let i = 0; i < 100; i++) {
					if (cancelSignal.cancelled) return { cancelled: true };
					onChunk({ pcm: new Float32Array(320).fill(0.1), isFinal: false });
					await Promise.resolve();
				}
				onChunk({ pcm: new Float32Array(0), isFinal: true });
				return { cancelled: false };
			},
		);
		expect(cancelMs).toBeGreaterThanOrEqual(0);
		expect(Number.isFinite(cancelMs)).toBe(true);
	});

	it("fails fast when the stream produces no audio to cancel", async () => {
		await expect(
			measureBargeInPlaybackStopMs(async ({ onChunk }) => {
				onChunk({ pcm: new Float32Array(0), isFinal: true });
				return { cancelled: false };
			}),
		).rejects.toThrow(/produced no audio/);
	});

	it("fails fast when the engine ignores the cancel signal", async () => {
		await expect(
			measureBargeInPlaybackStopMs(async ({ onChunk }) => {
				for (let i = 0; i < 3; i++) {
					onChunk({ pcm: new Float32Array(320).fill(0.1), isFinal: false });
				}
				onChunk({ pcm: new Float32Array(0), isFinal: true });
				return { cancelled: false };
			}),
		).rejects.toThrow(/ignored the barge-in cancel/);
	});
});
