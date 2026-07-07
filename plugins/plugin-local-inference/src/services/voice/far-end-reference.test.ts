/**
 * Desktop far-end reference + utterance-level AEC (#12256) — real DSP end to
 * end: real EchoReferenceBuffer, real alignment estimator, real NLMS
 * canceller; only the clocks are simulated (renderer performance.now() vs
 * server Date.now() epochs, delivery jitter, POST latency).
 */

import { describe, expect, it } from "vitest";
import type { AudioFrameEvent } from "./audio-frame-consumer";
import { cancelEchoInWavUtterance, FarEndReference } from "./far-end-reference";
import { encodeMonoPcm16Wav } from "./wav-codec";

const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 320; // 20 ms
/** Simulated renderer→server clock epoch difference (performance.now() is
 * page-relative, so the real offset is huge; any constant works). */
const EPOCH_OFFSET_MS = 1_000_000;
/** Minimum simulated delivery latency — the epoch anchor converges to it. */
const MIN_DELIVERY_MS = 5;

/** Deterministic pseudo-speech (seeded noise → low-pass → slow envelope). */
function speechLike(n: number, seed: number): Float32Array {
	const out = new Float32Array(n);
	let state = seed >>> 0 || 1;
	const rand = () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0xffffffff - 0.5;
	};
	let lp = 0;
	for (let i = 0; i < n; i++) {
		const t = i / SAMPLE_RATE;
		lp = 0.85 * lp + 0.15 * rand();
		out[i] = (0.55 + 0.45 * Math.sin(2 * Math.PI * 2.3 * t + seed)) * lp * 2.5;
	}
	return out;
}

function encodePcm16Base64(pcm: Float32Array): string {
	const bytes = Buffer.alloc(pcm.length * 2);
	for (let i = 0; i < pcm.length; i++) {
		const v = Math.max(-1, Math.min(1, pcm[i]));
		bytes.writeInt16LE(Math.round(v * 32767), i * 2);
	}
	return bytes.toString("base64");
}

/** Slice a far stream into 20 ms wire frames timestamped in renderer clock. */
function toFrames(stream: Float32Array, baseTsMs: number): AudioFrameEvent[] {
	const frames: AudioFrameEvent[] = [];
	for (
		let index = 0;
		(index + 1) * FRAME_SAMPLES <= stream.length;
		index += 1
	) {
		const pcm = stream.subarray(
			index * FRAME_SAMPLES,
			(index + 1) * FRAME_SAMPLES,
		);
		frames.push({
			pcm16: encodePcm16Base64(pcm),
			sampleRate: SAMPLE_RATE,
			channels: 1,
			samples: FRAME_SAMPLES,
			rms: 0.1,
			timestamp: baseTsMs + index * 20,
			frameIndex: index,
		});
	}
	return frames;
}

/** Push a far stream with realistic per-batch delivery jitter (≥ MIN_DELIVERY). */
function deliver(
	farEnd: FarEndReference,
	stream: Float32Array,
	baseTsMs: number,
): void {
	const frames = toFrames(stream, baseTsMs);
	for (let i = 0; i < frames.length; i += 12) {
		const batch = frames.slice(i, i + 12);
		const last = batch[batch.length - 1];
		const jitter = MIN_DELIVERY_MS + ((i / 12) % 4) * 60; // 5..185 ms
		farEnd.pushPlayback(batch, last.timestamp + EPOCH_OFFSET_MS + jitter);
	}
}

/** The mic hears the far stream attenuated + delayed by `acousticDelayMs`. */
function echoOf(
	stream: Float32Array,
	baseTsMs: number,
	nearStartTsMs: number,
	lengthSamples: number,
	acousticDelayMs: number,
	gain = 0.22,
): Float32Array {
	const near = new Float32Array(lengthSamples);
	const srcBase = Math.round(
		((nearStartTsMs - acousticDelayMs - baseTsMs) / 1000) * SAMPLE_RATE,
	);
	for (let i = 0; i < lengthSamples; i++) {
		const k = srcBase + i;
		if (k >= 0 && k < stream.length) near[i] = gain * stream[k];
	}
	return near;
}

describe("FarEndReference.cancelUtterance", () => {
	it("cancels an echo-only utterance with ERLE >= 18 dB", () => {
		const farEnd = new FarEndReference();
		const far = speechLike(48_000, 7); // 3 s of playback
		const baseTs = 5_000;
		deliver(farEnd, far, baseTs);

		const nearStartTs = 5_100;
		const nearLen = 40_000; // 2.5 s utterance
		const near = echoOf(far, baseTs, nearStartTs, nearLen, 60);
		const nearEndTs = nearStartTs + (nearLen / SAMPLE_RATE) * 1000;
		const result = farEnd.cancelUtterance(
			near,
			nearEndTs + EPOCH_OFFSET_MS + 15, // POST arrival latency
		);

		expect(result.applied).toBe(true);
		expect(result.confidence ?? 0).toBeGreaterThanOrEqual(0.3);
		expect(result.erleDb).not.toBeNull();
		expect(result.erleDb as number).toBeGreaterThanOrEqual(18);
		expect(result.farActiveSamples).toBeGreaterThan(SAMPLE_RATE);
		expect(farEnd.status().lastErleDb).toBe(result.erleDb);
	});

	it("passes through bit-exact when no playback was ever delivered", () => {
		const farEnd = new FarEndReference();
		const near = speechLike(16_000, 3);
		const result = farEnd.cancelUtterance(near, Date.now());
		expect(result.applied).toBe(false);
		expect(result.reason).toBe("no-far-end");
		expect(result.pcm).toBe(near); // the untouched input array
	});

	it("drops a malformed playback frame instead of throwing", () => {
		const farEnd = new FarEndReference();
		const good = speechLike(FRAME_SAMPLES, 1);
		const oddFrame: AudioFrameEvent = {
			pcm16: Buffer.alloc(807).toString("base64"), // odd byte length
			sampleRate: SAMPLE_RATE,
			channels: 1,
			samples: 403,
			rms: 0.1,
			timestamp: 0,
			frameIndex: 0,
		};
		const goodFrame: AudioFrameEvent = {
			pcm16: encodePcm16Base64(good),
			sampleRate: SAMPLE_RATE,
			channels: 1,
			samples: FRAME_SAMPLES,
			rms: 0.1,
			timestamp: 20,
			frameIndex: 1,
		};
		expect(() => farEnd.pushPlayback([oddFrame, goodFrame])).not.toThrow();
		const status = farEnd.status();
		expect(status.playbackFramesDropped).toBe(1);
		expect(status.playbackFramesReceived).toBe(1);
		expect(status.playbackSamplesReceived).toBe(FRAME_SAMPLES);
	});

	it("passes through bit-exact when the utterance carries no correlated echo", () => {
		const farEnd = new FarEndReference();
		const far = speechLike(48_000, 11);
		const baseTs = 9_000;
		deliver(farEnd, far, baseTs);
		// Independent user speech overlapping the playback window in time.
		const near = speechLike(32_000, 987_654);
		const nearEndTs = baseTs + 2_800;
		const result = farEnd.cancelUtterance(
			near,
			nearEndTs + EPOCH_OFFSET_MS + 15,
		);
		expect(result.applied).toBe(false);
		expect(result.reason).toBe("low-confidence");
		expect(result.pcm).toBe(near);
	});

	it("preserves double-talk user speech while cancelling the echo underneath", () => {
		const farEnd = new FarEndReference();
		const far = speechLike(48_000, 21);
		const baseTs = 40_000;
		deliver(farEnd, far, baseTs);

		const nearStartTs = 40_200;
		const nearLen = 40_000;
		const echo = echoOf(far, baseTs, nearStartTs, nearLen, 45, 0.25);
		const user = speechLike(nearLen, 4242);
		const near = new Float32Array(nearLen);
		for (let i = 0; i < nearLen; i++) near[i] = echo[i] + 0.3 * user[i];

		const nearEndTs = nearStartTs + (nearLen / SAMPLE_RATE) * 1000;
		const result = farEnd.cancelUtterance(
			near,
			nearEndTs + EPOCH_OFFSET_MS + 10,
		);
		expect(result.applied).toBe(true);

		// The user's speech must survive (residual stays user-dominated) while
		// the echo component shrinks. Continuous double-talk perturbs the NLMS
		// gradient, so the user correlation is high-but-not-perfect by design.
		const corr = (a: Float32Array, b: Float32Array): number => {
			let dot = 0;
			let ea = 0;
			let eb = 0;
			for (let i = 0; i < nearLen; i++) {
				dot += a[i] * b[i];
				ea += a[i] * a[i];
				eb += b[i] * b[i];
			}
			return dot / Math.sqrt(ea * eb);
		};
		expect(corr(result.pcm, user)).toBeGreaterThan(0.7);
		expect(Math.abs(corr(result.pcm, echo))).toBeLessThan(
			0.5 * corr(near, echo),
		);
	});

	it("keeps the far-end history across playback resets (the pump resets before the WAV arrives)", () => {
		const farEnd = new FarEndReference();
		const far = speechLike(48_000, 31);
		const baseTs = 70_000;
		deliver(farEnd, far, baseTs);
		farEnd.notePlaybackReset(); // playback segment ended
		const nearStartTs = 70_150;
		const nearLen = 32_000;
		const near = echoOf(far, baseTs, nearStartTs, nearLen, 70);
		const nearEndTs = nearStartTs + (nearLen / SAMPLE_RATE) * 1000;
		const result = farEnd.cancelUtterance(
			near,
			nearEndTs + EPOCH_OFFSET_MS + 20,
		);
		expect(result.applied).toBe(true);
		expect(farEnd.status().playbackResets).toBe(1);
	});

	it("reports honest wiring status", () => {
		const farEnd = new FarEndReference();
		expect(farEnd.status().echoReferenceWired).toBe(false);
		deliver(farEnd, speechLike(16_000, 5), 1_000);
		const status = farEnd.status();
		expect(status.echoReferenceWired).toBe(true);
		expect(status.playbackSamplesReceived).toBeGreaterThan(0);
		expect(status.epochOffsetKnown).toBe(true);
	});
});

describe("cancelEchoInWavUtterance", () => {
	it("cancels a 16 kHz WAV utterance and re-encodes the residual", () => {
		const farEnd = new FarEndReference();
		const far = speechLike(48_000, 51);
		const baseTs = 100_000;
		deliver(farEnd, far, baseTs);
		const nearStartTs = 100_120;
		const near = echoOf(far, baseTs, nearStartTs, 40_000, 55);
		const wav = encodeMonoPcm16Wav(near, SAMPLE_RATE);
		const nearEndTs = nearStartTs + (near.length / SAMPLE_RATE) * 1000;

		const outcome = cancelEchoInWavUtterance(
			farEnd,
			wav,
			nearEndTs + EPOCH_OFFSET_MS + 12,
		);
		expect(outcome.result?.applied).toBe(true);
		expect(outcome.bytes).not.toBe(wav);
		// Residual WAV is dramatically quieter than the echo it replaced.
		expect(outcome.result?.erleDb as number).toBeGreaterThanOrEqual(18);
	});

	it("passes non-WAV payloads through untouched with no AEC verdict", () => {
		const farEnd = new FarEndReference();
		const bytes = new Uint8Array([1, 2, 3, 4, 5]);
		const outcome = cancelEchoInWavUtterance(farEnd, bytes);
		expect(outcome.bytes).toBe(bytes);
		expect(outcome.result).toBeNull();
	});

	it("passes RIFF-tagged but non-PCM16-mono payloads through untouched", () => {
		const farEnd = new FarEndReference();
		// Valid RIFF/WAVE magic, garbage format chunk.
		const bytes = new Uint8Array(64);
		bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
		bytes.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
		const outcome = cancelEchoInWavUtterance(farEnd, bytes);
		expect(outcome.bytes).toBe(bytes);
		expect(outcome.result).toBeNull();
	});
});
