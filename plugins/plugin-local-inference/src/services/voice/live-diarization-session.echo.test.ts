/**
 * LiveDiarizationSession echo-reference wiring (#9455/#9583).
 *
 * Proves the agent-side AEC seam without the fused FFI: the session decodes
 * agent-playback (far-end) frames into its alignment buffer, and the
 * `echoReference` read seam (the closure handed to AudioFrameConsumer) returns
 * the time-aligned far-end slice — zero-filled until playback is pushed, and
 * reset on barge-in. The model-heavy path (real NLMS cancellation over the
 * fused VAD/encoder/diarizer) is covered by the host smoke harness.
 */

import { describe, expect, it } from "vitest";
import type { AudioFrameEvent } from "./audio-frame-consumer.js";
import { platformPlaybackDelaySamples } from "./echo-delay.js";
import {
	LiveDiarizationSession,
	type RuntimeEventSink,
} from "./live-diarization-session.js";

const SAMPLE_RATE = 16_000;

function fakeRuntime(): RuntimeEventSink {
	return { emitEvent: async () => {} } as unknown as RuntimeEventSink;
}

/** Build a well-formed playback frame from Float32 [-1,1] samples. */
function playbackFrame(
	samples: Float32Array,
	frameIndex: number,
): AudioFrameEvent {
	const buf = Buffer.alloc(samples.length * 2);
	for (let i = 0; i < samples.length; i += 1) {
		const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
		buf.writeInt16LE(Math.round(clamped * 32_768) | 0, i * 2);
	}
	return {
		pcm16: buf.toString("base64"),
		sampleRate: SAMPLE_RATE,
		channels: 1,
		samples: samples.length,
		rms: 0,
		timestamp: frameIndex * 20,
		frameIndex,
	};
}

/** A deterministic ramp in [-0.5, 0.5]. */
function ramp(n: number): Float32Array {
	const out = new Float32Array(n);
	for (let i = 0; i < n; i += 1) out[i] = i / n - 0.5;
	return out;
}

function noise(n: number): Float32Array {
	const out = new Float32Array(n);
	let seed = 0x12345678;
	for (let i = 0; i < n; i += 1) {
		seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
		out[i] = ((seed / 0xffffffff) * 2 - 1) * 0.6;
	}
	return out;
}

describe("LiveDiarizationSession echo reference", () => {
	it("returns a zero far-end reference before any playback is pushed", () => {
		const session = new LiveDiarizationSession(fakeRuntime());
		const ref = session.echoReferenceFrame(0, 320);
		expect(ref).toHaveLength(320);
		expect(ref.every((v) => v === 0)).toBe(true);
	});

	it("aligns playback by frame timestamp as the far-end (delay 0)", () => {
		const session = new LiveDiarizationSession(fakeRuntime());
		const playback = ramp(320);
		session.pushPlayback([playbackFrame(playback, 0)]);

		const ref = session.echoReferenceFrame(0, 320);
		expect(ref).toHaveLength(320);
		// Not zero-filled — the canceller now has a real far-end to cancel.
		expect(ref.some((v) => v !== 0)).toBe(true);
		// s16 round-trip is exact to ~1/32768; assert close alignment to the
		// pushed ramp, not silence.
		for (let i = 0; i < 320; i += 1) {
			expect(Math.abs((ref[i] ?? 0) - (playback[i] ?? 0))).toBeLessThan(1e-3);
		}
	});

	it("returns the trailing window when asked for fewer samples than pushed", () => {
		const session = new LiveDiarizationSession(fakeRuntime());
		const playback = ramp(640);
		session.pushPlayback([playbackFrame(playback, 0)]);

		const ref = session.echoReferenceFrame(20, 320);
		expect(ref).toHaveLength(320);
		// The aligned window is the LAST 320 of the 640 pushed (delay 0).
		for (let i = 0; i < 320; i += 1) {
			expect(Math.abs((ref[i] ?? 0) - (playback[320 + i] ?? 0))).toBeLessThan(
				1e-3,
			);
		}
	});

	it("resetPlayback drops buffered far-end (barge-in / playback stop)", () => {
		const session = new LiveDiarizationSession(fakeRuntime());
		session.pushPlayback([playbackFrame(ramp(320), 0)]);
		expect(session.echoReferenceFrame(0, 320).some((v) => v !== 0)).toBe(true);

		session.resetPlayback();
		expect(session.echoReferenceFrame(0, 320).every((v) => v === 0)).toBe(true);
	});

	it("zero-fills natural gaps between playback frames", () => {
		const session = new LiveDiarizationSession(fakeRuntime());
		const first = ramp(320);
		const later = ramp(320);
		session.pushPlayback([playbackFrame(first, 0), playbackFrame(later, 5)]);

		expect(session.echoReferenceFrame(0, 320).some((v) => v !== 0)).toBe(true);
		expect(session.echoReferenceFrame(40, 320).every((v) => v === 0)).toBe(
			true,
		);
		expect(session.echoReferenceFrame(100, 320).some((v) => v !== 0)).toBe(
			true,
		);
	});

	it("self-calibrates playback-to-mic delay from correlated echo", () => {
		const session = new LiveDiarizationSession(fakeRuntime());
		const frameSamples = 320;
		const totalSamples = 16_000;
		const delaySamples = 240;
		const playback = noise(totalSamples);

		for (let offset = 0; offset < totalSamples; offset += frameSamples) {
			session.pushPlayback([
				playbackFrame(
					playback.slice(offset, offset + frameSamples),
					offset / frameSamples,
				),
			]);
		}

		for (let offset = 0; offset < totalSamples; offset += frameSamples) {
			const near = new Float32Array(frameSamples);
			for (let i = 0; i < frameSamples; i += 1) {
				near[i] = playback[offset + i - delaySamples] ?? 0;
			}
			session.observeForDelayCalibration(near, (offset / SAMPLE_RATE) * 1000);
			if (session.aecDelayState().calibrated) break;
		}

		const state = session.aecDelayState();
		expect(state.calibrated).toBe(true);
		expect(Math.abs(state.delaySamples - delaySamples)).toBeLessThanOrEqual(1);
		expect(state.confidence).toBeGreaterThan(0.95);
	});

	it("seeds the echo delay from the platform default when ELIZA_VOICE_ECHO_DELAY_MS=auto", () => {
		const prev = process.env.ELIZA_VOICE_ECHO_DELAY_MS;
		process.env.ELIZA_VOICE_ECHO_DELAY_MS = "auto";
		try {
			const session = new LiveDiarizationSession(fakeRuntime());
			// Seed comes straight from the per-platform table (#9583); runtime
			// calibration would refine it later, but at construction it equals the
			// platform default for the host the test runs on.
			expect(session.aecDelayState().delaySamples).toBe(
				platformPlaybackDelaySamples(process.platform, SAMPLE_RATE),
			);
		} finally {
			if (prev === undefined) delete process.env.ELIZA_VOICE_ECHO_DELAY_MS;
			else process.env.ELIZA_VOICE_ECHO_DELAY_MS = prev;
		}
	});

	it("resolves the ELIZA_PLATFORM id (ios) for the auto seed, not the host's darwin seed (#9583)", () => {
		const prevDelay = process.env.ELIZA_VOICE_ECHO_DELAY_MS;
		const prevPlatform = process.env.ELIZA_PLATFORM;
		process.env.ELIZA_VOICE_ECHO_DELAY_MS = "auto";
		process.env.ELIZA_PLATFORM = "ios";
		try {
			const session = new LiveDiarizationSession(fakeRuntime());
			// The mobile shell reports ELIZA_PLATFORM=ios even though the host's
			// process.platform is darwin. The auto seed must follow the device id
			// (#9653 ios table = 400 samples @16kHz), NOT the darwin host seed
			// (320 samples) — otherwise the deliberate per-platform seeds are
			// unreachable on device.
			expect(session.aecDelayState().delaySamples).toBe(
				platformPlaybackDelaySamples("ios", SAMPLE_RATE),
			);
			expect(session.aecDelayState().delaySamples).toBe(400);
			expect(session.aecDelayState().delaySamples).not.toBe(
				platformPlaybackDelaySamples("darwin", SAMPLE_RATE),
			);
		} finally {
			if (prevDelay === undefined) delete process.env.ELIZA_VOICE_ECHO_DELAY_MS;
			else process.env.ELIZA_VOICE_ECHO_DELAY_MS = prevDelay;
			if (prevPlatform === undefined) delete process.env.ELIZA_PLATFORM;
			else process.env.ELIZA_PLATFORM = prevPlatform;
		}
	});

	it("resolves the ELIZA_PLATFORM id (android) for the auto seed (#9583)", () => {
		const prevDelay = process.env.ELIZA_VOICE_ECHO_DELAY_MS;
		const prevPlatform = process.env.ELIZA_PLATFORM;
		process.env.ELIZA_VOICE_ECHO_DELAY_MS = "auto";
		process.env.ELIZA_PLATFORM = "android";
		try {
			const session = new LiveDiarizationSession(fakeRuntime());
			expect(session.aecDelayState().delaySamples).toBe(
				platformPlaybackDelaySamples("android", SAMPLE_RATE),
			);
			expect(session.aecDelayState().delaySamples).toBe(720);
		} finally {
			if (prevDelay === undefined) delete process.env.ELIZA_VOICE_ECHO_DELAY_MS;
			else process.env.ELIZA_VOICE_ECHO_DELAY_MS = prevDelay;
			if (prevPlatform === undefined) delete process.env.ELIZA_PLATFORM;
			else process.env.ELIZA_PLATFORM = prevPlatform;
		}
	});

	it("defaults the echo delay seed to 0 when no override is set", () => {
		const prev = process.env.ELIZA_VOICE_ECHO_DELAY_MS;
		delete process.env.ELIZA_VOICE_ECHO_DELAY_MS;
		try {
			const session = new LiveDiarizationSession(fakeRuntime());
			expect(session.aecDelayState().delaySamples).toBe(0);
		} finally {
			if (prev === undefined) delete process.env.ELIZA_VOICE_ECHO_DELAY_MS;
			else process.env.ELIZA_VOICE_ECHO_DELAY_MS = prev;
		}
	});
});
