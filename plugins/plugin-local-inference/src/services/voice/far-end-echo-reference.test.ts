/**
 * Deterministic coverage for the process-local far-end reference used by
 * desktop local ASR. The fixtures synthesize the exact playback-frame wire
 * format so the test exercises timestamp alignment, WAV decoding, NLMS, and
 * ERLE telemetry without loading native inference libraries.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { AudioFrameEvent } from "./audio-frame-consumer.js";
import {
	AUDIO_FRAME_PIPELINE_SAMPLE_RATE,
	decodeAudioFramePcm,
} from "./audio-frame-consumer.js";
import { computeErle } from "./echo-metrics.js";
import { FarEndEchoReference } from "./far-end-echo-reference.js";
import { decodeMonoPcm16Wav, encodeMonoPcm16Wav } from "./wav-codec.js";

const FRAME_SAMPLES = 320;

const previousResidualSuppression =
	process.env.ELIZA_VOICE_RESIDUAL_SUPPRESSION;

afterEach(() => {
	if (previousResidualSuppression === undefined) {
		delete process.env.ELIZA_VOICE_RESIDUAL_SUPPRESSION;
	} else {
		process.env.ELIZA_VOICE_RESIDUAL_SUPPRESSION = previousResidualSuppression;
	}
});

function syntheticSpeech(samples: number): Float32Array {
	const out = new Float32Array(samples);
	let seed = 0x12345678;
	for (let index = 0; index < samples; index += 1) {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		const noise = (seed / 0xffffffff - 0.5) * 0.08;
		const voiced =
			Math.sin((2 * Math.PI * 220 * index) / AUDIO_FRAME_PIPELINE_SAMPLE_RATE) *
			0.18;
		out[index] = voiced + noise;
	}
	return out;
}

function rms(pcm: Float32Array): number {
	let sum = 0;
	for (const sample of pcm) sum += sample * sample;
	return Math.sqrt(sum / Math.max(1, pcm.length));
}

function encodeFramePcm16(pcm: Float32Array): string {
	const bytes = Buffer.alloc(pcm.length * 2);
	for (let index = 0; index < pcm.length; index += 1) {
		const sample = Math.max(-1, Math.min(1, pcm[index] ?? 0));
		bytes.writeInt16LE(Math.round(sample * 32767), index * 2);
	}
	return bytes.toString("base64");
}

function playbackFrames(
	pcm: Float32Array,
	startedAtMs: number,
): AudioFrameEvent[] {
	const frames: AudioFrameEvent[] = [];
	for (let offset = 0; offset < pcm.length; offset += FRAME_SAMPLES) {
		const chunk = pcm.subarray(offset, offset + FRAME_SAMPLES);
		frames.push({
			pcm16: encodeFramePcm16(chunk),
			sampleRate: AUDIO_FRAME_PIPELINE_SAMPLE_RATE,
			channels: 1,
			samples: chunk.length,
			rms: rms(chunk),
			timestamp:
				startedAtMs + (offset / AUDIO_FRAME_PIPELINE_SAMPLE_RATE) * 1000,
			frameIndex: frames.length,
		});
	}
	return frames;
}

describe("FarEndEchoReference", () => {
	it("leaves local-ASR WAV bytes untouched when capture timing is absent", () => {
		const reference = new FarEndEchoReference();
		const startedAtMs = 1_000;
		const far = syntheticSpeech(AUDIO_FRAME_PIPELINE_SAMPLE_RATE);
		const wav = encodeMonoPcm16Wav(far, AUDIO_FRAME_PIPELINE_SAMPLE_RATE);

		reference.pushPlayback(playbackFrames(far, startedAtMs));
		const result = reference.cancelAsrWav(wav);

		expect(result.applied).toBe(false);
		expect(result.framesCancelled).toBe(0);
		expect(Array.from(result.audio)).toEqual(Array.from(wav));
	});

	it("applies NLMS cancellation and exposes ERLE when timing aligns with playback", () => {
		process.env.ELIZA_VOICE_RESIDUAL_SUPPRESSION = "0.1";
		const reference = new FarEndEchoReference();
		const startedAtMs = 2_000;
		const far = syntheticSpeech(AUDIO_FRAME_PIPELINE_SAMPLE_RATE * 2);
		const nearEcho = far.slice();
		const wav = encodeMonoPcm16Wav(nearEcho, AUDIO_FRAME_PIPELINE_SAMPLE_RATE);

		reference.pushPlayback(playbackFrames(far, startedAtMs));
		const result = reference.cancelAsrWav(wav, {
			captureStartedAtMs: startedAtMs,
			captureEndedAtMs: startedAtMs + 2_000,
		});
		const cleaned = decodeMonoPcm16Wav(result.audio).pcm;

		expect(result.applied).toBe(true);
		expect(result.framesCancelled).toBeGreaterThan(0);
		expect(Array.from(result.audio)).not.toEqual(Array.from(wav));
		expect(computeErle(nearEcho, cleaned)).toBeGreaterThan(3);
		expect(reference.status().asrFramesCancelled).toBe(result.framesCancelled);
		expect(reference.status().lastAsrErleDb).toBeGreaterThan(3);
		const firstPlaybackFrame = playbackFrames(far, startedAtMs)[0];
		expect(firstPlaybackFrame).toBeDefined();
		if (!firstPlaybackFrame) throw new Error("missing playback frame");
		expect(decodeAudioFramePcm(firstPlaybackFrame).length).toBe(FRAME_SAMPLES);
	});
});
