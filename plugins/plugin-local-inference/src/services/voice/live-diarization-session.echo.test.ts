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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

	it("reports echoReferenceWired=false while the consumer is built but no playback ever arrived (#9583)", async () => {
		const session = new LiveDiarizationSession(fakeRuntime());
		// Simulate the on-device state where the fused consumer built fine but no
		// far-end playback was ever delivered. The old status computed
		// `wired = consumer != null || options.echoReference != null` — a
		// tautology that read true here even though the canceller had only a
		// zero-filled reference (i.e. AEC was NOT doing anything).
		(session as unknown as { consumer: { droppedFrames: number } }).consumer = {
			droppedFrames: 0,
		};

		const before = await session.status();
		expect(before.ready).toBe(true);
		expect(before.aec.echoReferenceWired).toBe(false);
		expect(before.aec.playbackFramesReceived).toBe(0);
		expect(before.aec.playbackSamplesReceived).toBe(0);
		expect(before.aec.lastPlaybackFrameAt).toBeNull();

		session.pushPlayback([playbackFrame(ramp(320), 0)]);

		const after = await session.status();
		expect(after.aec.echoReferenceWired).toBe(true);
		expect(after.aec.playbackFramesReceived).toBe(1);
		expect(after.aec.playbackSamplesReceived).toBe(320);
		expect(typeof after.aec.lastPlaybackFrameAt).toBe("number");
	});

	describe("status() AEC truthfulness with a deterministic build failure", () => {
		// Force the fused-lib resolution to fail so the (heavy, host-dependent)
		// consumer build never runs: the wired signal must track far-end DELIVERY
		// and provider registration, not the consumer build.
		let prevLib: string | undefined;
		let prevDir: string | undefined;
		beforeEach(() => {
			prevLib = process.env.ELIZA_INFERENCE_LIBRARY;
			prevDir = process.env.ELIZA_INFERENCE_LIB_DIR;
			process.env.ELIZA_INFERENCE_LIBRARY = "/nonexistent/libelizainference.so";
			delete process.env.ELIZA_INFERENCE_LIB_DIR;
		});
		afterEach(() => {
			if (prevLib === undefined) delete process.env.ELIZA_INFERENCE_LIBRARY;
			else process.env.ELIZA_INFERENCE_LIBRARY = prevLib;
			if (prevDir !== undefined) process.env.ELIZA_INFERENCE_LIB_DIR = prevDir;
		});

		it("flips echoReferenceWired on real far-end delivery even when the consumer never built", async () => {
			const session = new LiveDiarizationSession(fakeRuntime());
			const before = await session.status();
			expect(before.ready).toBe(false);
			expect(before.aec.echoReferenceWired).toBe(false);

			session.pushPlayback([
				playbackFrame(ramp(320), 0),
				playbackFrame(ramp(320), 1),
			]);

			const after = await session.status();
			expect(after.aec.echoReferenceWired).toBe(true);
			expect(after.aec.playbackFramesReceived).toBe(2);
			expect(after.aec.playbackSamplesReceived).toBe(640);
		});

		it("reports echoReferenceWired=true for a host-registered provider with zero playback frames", async () => {
			const session = new LiveDiarizationSession(fakeRuntime(), {
				echoReference: () => new Float32Array(320),
			});
			const status = await session.status();
			expect(status.aec.echoReferenceWired).toBe(true);
			expect(status.aec.playbackFramesReceived).toBe(0);
			expect(status.aec.lastPlaybackFrameAt).toBeNull();
		});

		it("keeps cumulative delivery counters (and wired) across resetPlayback", async () => {
			const session = new LiveDiarizationSession(fakeRuntime());
			session.pushPlayback([playbackFrame(ramp(320), 0)]);
			session.resetPlayback();
			// The buffer is dropped (barge-in), but the transport already proved it
			// delivers — the wiring evidence is cumulative, not a live-buffer gauge.
			expect(session.echoReferenceFrame(0, 320).every((v) => v === 0)).toBe(
				true,
			);
			const status = await session.status();
			expect(status.aec.echoReferenceWired).toBe(true);
			expect(status.aec.playbackFramesReceived).toBe(1);
			expect(status.aec.playbackSamplesReceived).toBe(320);
		});

		it("ingest() still captures AEC evidence when the fused diarizer cannot build (#11373 iOS)", async () => {
			// On builds that ship no fused voice lib the diarizer never builds, but
			// the AEC evidence transport must still work — otherwise on-device
			// aec-capture is impossible (the whole reason iOS could not capture).
			const session = new LiveDiarizationSession(fakeRuntime());
			session.armAecCapture(2);
			session.pushPlayback([playbackFrame(noise(320), 0)]);

			// ingest must NOT throw despite the deterministic build failure.
			await session.ingest([playbackFrame(noise(320), 0)]);
			await session.ingest([playbackFrame(noise(320), 1)]);

			const snap = session.aecCaptureSnapshot();
			expect(snap.sampleCount).toBe(640);
			const status = await session.status();
			expect(status.ready).toBe(false); // diarizer never built
			expect(status.framesReceived).toBe(2); // but frames were ingested
			expect(typeof status.error).toBe("string"); // build failure surfaced
		});
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

	it("calibrates a ~400 ms transport delay (Pixel 6a WebView pump path, #11373)", () => {
		// The Pixel 6a device evidence measured ~381–408 ms playback→mic on the
		// WebView pump path — beyond the previous 300 ms search ceiling, which
		// made the one-shot calibration lock a wrong cap-edge lag.
		const session = new LiveDiarizationSession(fakeRuntime());
		const frameSamples = 320;
		const totalSamples = 40_000;
		const delaySamples = 6_400; // 400 ms @16 kHz
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
	});

	it("refuses to lock a cap-edge delay estimate (#11373)", () => {
		// A correlation peak within one frame of the search ceiling means the
		// true delay is likely beyond the searched range; a one-shot lock there
		// would pin a wrong alignment forever. The session must keep the seed.
		const session = new LiveDiarizationSession(fakeRuntime());
		const frameSamples = 320;
		const totalSamples = 40_000;
		const delaySamples = 7_900; // inside the search range but at the cap edge
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
		}

		expect(session.aecDelayState().calibrated).toBe(false);
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

	describe("bounded AEC evidence capture (#11373)", () => {
		/** Decode base64 LE-s16 into Float32 [-1,1]. */
		function decodePcm16(b64: string): Float32Array {
			const buf = Buffer.from(b64, "base64");
			const out = new Float32Array(buf.length >> 1);
			for (let i = 0; i < out.length; i += 1) {
				out[i] = buf.readInt16LE(i * 2) / 32768;
			}
			return out;
		}

		it("captures nothing until armed, then buffers near + delay-0 far per frame", () => {
			const session = new LiveDiarizationSession(fakeRuntime());
			const playback = ramp(320);
			session.pushPlayback([playbackFrame(playback, 0)]);

			// Not armed → no-op.
			session.captureAecFrame(noise(320), 0);
			expect(session.aecCaptureStatus().sampleCount).toBe(0);

			session.armAecCapture(1);
			const near = noise(320);
			session.captureAecFrame(near, 0);

			const snap = session.aecCaptureSnapshot();
			expect(snap.armed).toBe(true);
			expect(snap.sampleCount).toBe(320);
			expect(snap.sampleRate).toBe(SAMPLE_RATE);
			expect(snap.startTimestampMs).toBe(0);

			const capturedNear = decodePcm16(snap.nearPcm16);
			const capturedFar = decodePcm16(snap.farPcm16);
			expect(capturedNear).toHaveLength(320);
			expect(capturedFar).toHaveLength(320);
			for (let i = 0; i < 320; i += 1) {
				expect(Math.abs(capturedNear[i] - near[i])).toBeLessThan(1e-3);
				// Far side is the delay-0 reference: the pushed playback ramp.
				expect(Math.abs(capturedFar[i] - playback[i])).toBeLessThan(1e-3);
			}
		});

		it("stops at the sample cap and disarms itself", () => {
			const session = new LiveDiarizationSession(fakeRuntime());
			session.armAecCapture(1); // 16 000-sample cap
			for (let i = 0; i < 60; i += 1) {
				session.captureAecFrame(noise(320), i * 20);
			}
			const status = session.aecCaptureStatus();
			// 50 frames fill the 16 000-sample budget; the 51st flips armed off.
			expect(status.sampleCount).toBe(16_000);
			expect(status.armed).toBe(false);
		});

		it("clamps maxSeconds to the hard 60 s ceiling", () => {
			const session = new LiveDiarizationSession(fakeRuntime());
			const status = session.armAecCapture(6_000);
			expect(status.maxSamples).toBe(60 * SAMPLE_RATE);
		});

		it("re-arming restarts the window; disarm keeps it readable", () => {
			const session = new LiveDiarizationSession(fakeRuntime());
			session.armAecCapture(1);
			session.captureAecFrame(noise(320), 0);
			expect(session.aecCaptureStatus().sampleCount).toBe(320);

			session.disarmAecCapture();
			expect(session.aecCaptureStatus().armed).toBe(false);
			// Disarm freezes but does not clear.
			expect(session.aecCaptureSnapshot().sampleCount).toBe(320);
			// Frames after disarm are ignored.
			session.captureAecFrame(noise(320), 20);
			expect(session.aecCaptureStatus().sampleCount).toBe(320);

			session.armAecCapture(1);
			expect(session.aecCaptureStatus().sampleCount).toBe(0);
			expect(session.aecCaptureStatus().armed).toBe(true);
		});

		it("snapshot reports the delay state applied during the window", () => {
			const prev = process.env.ELIZA_VOICE_ECHO_DELAY_MS;
			process.env.ELIZA_VOICE_ECHO_DELAY_MS = "50";
			try {
				const session = new LiveDiarizationSession(fakeRuntime());
				session.armAecCapture(1);
				session.captureAecFrame(noise(320), 0);
				const snap = session.aecCaptureSnapshot();
				expect(snap.echoDelaySamples).toBe(800); // 50 ms @16 kHz
				expect(snap.echoDelayCalibrated).toBe(false);
			} finally {
				if (prev === undefined) delete process.env.ELIZA_VOICE_ECHO_DELAY_MS;
				else process.env.ELIZA_VOICE_ECHO_DELAY_MS = prev;
			}
		});
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
