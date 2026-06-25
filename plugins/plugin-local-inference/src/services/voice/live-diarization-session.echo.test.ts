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
import {
	LiveDiarizationSession,
	type RuntimeEventSink,
} from "./live-diarization-session.js";

const SAMPLE_RATE = 16_000;

function fakeRuntime(): RuntimeEventSink {
	return { emitEvent: async () => {} } as unknown as RuntimeEventSink;
}

/** Build a well-formed playback frame from Float32 [-1,1] samples. */
function playbackFrame(samples: Float32Array, frameIndex: number): AudioFrameEvent {
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
	for (let i = 0; i < n; i += 1) out[i] = (i / n) - 0.5;
	return out;
}

describe("LiveDiarizationSession echo reference", () => {
	it("returns a zero far-end reference before any playback is pushed", () => {
		const session = new LiveDiarizationSession(fakeRuntime());
		const ref = session.echoReferenceFrame(320);
		expect(ref).toHaveLength(320);
		expect(ref.every((v) => v === 0)).toBe(true);
	});

	it("aligns the most-recent pushed playback as the far-end (delay 0)", () => {
		const session = new LiveDiarizationSession(fakeRuntime());
		const playback = ramp(320);
		session.pushPlayback([playbackFrame(playback, 0)]);

		const ref = session.echoReferenceFrame(320);
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

		const ref = session.echoReferenceFrame(320);
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
		expect(session.echoReferenceFrame(320).some((v) => v !== 0)).toBe(true);

		session.resetPlayback();
		expect(session.echoReferenceFrame(320).every((v) => v === 0)).toBe(true);
	});
});
