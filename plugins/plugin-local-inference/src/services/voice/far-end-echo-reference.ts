/**
 * Process-local far-end playback reference for desktop local-ASR echo
 * cancellation. The WebView streams rendered TTS frames here through the
 * playback-frame route, and batch ASR uploads consume the aligned reference so
 * the agent does not transcribe its own speaker output.
 */

import type { AudioFrameEvent } from "./audio-frame-consumer.js";
import {
	AUDIO_FRAME_PIPELINE_SAMPLE_RATE,
	decodeAudioFramePcm,
} from "./audio-frame-consumer.js";
import {
	estimateEchoDelaySamples,
	platformPlaybackDelaySamples,
} from "./echo-delay.js";
import { computeErle } from "./echo-metrics.js";
import { EchoReferenceBuffer } from "./echo-reference-buffer.js";
import { NlmsEchoCanceller } from "./nlms-echo-canceller.js";
import { decodeMonoPcm16Wav, encodeMonoPcm16Wav } from "./wav-codec.js";

const ASR_AEC_FRAME_SAMPLES = 320;
const ECHO_CAL_TARGET_SAMPLES = 16_000;
const ECHO_CAL_MAX_SAMPLES = 24_000;
const ECHO_CAL_MIN_CONFIDENCE = 0.3;
const ECHO_CAL_MAX_LAG_SAMPLES = 8_000;
const ECHO_CAL_CAP_EDGE_SAMPLES = 320;
const ECHO_CAL_FAR_ENERGY_FLOOR = 1e-7;

export interface AsrEchoCancellationOptions {
	captureStartedAtMs?: number;
	captureEndedAtMs?: number;
}

export interface AsrEchoCancellationResult {
	audio: Uint8Array;
	applied: boolean;
	framesCancelled: number;
	lastErleDb: number | null;
}

export interface FarEndEchoReferenceStatus {
	echoReferenceWired: boolean;
	playbackFramesReceived: number;
	playbackSamplesReceived: number;
	lastPlaybackFrameAt: number | null;
	echoDelaySamples: number;
	echoDelayConfidence: number;
	echoDelayCalibrated: boolean;
	asrFramesCancelled: number;
	lastAsrErleDb: number | null;
}

function concatFloat32(chunks: Float32Array[]): Float32Array {
	let total = 0;
	for (const chunk of chunks) total += chunk.length;
	const out = new Float32Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

function meanSquare(pcm: Float32Array): number {
	if (pcm.length === 0) return 0;
	let energy = 0;
	for (let index = 0; index < pcm.length; index += 1) {
		const sample = pcm[index] ?? 0;
		energy += sample * sample;
	}
	return energy / pcm.length;
}

function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function resolveEchoDelaySamples(): number {
	const raw = process.env.ELIZA_VOICE_ECHO_DELAY_MS;
	if (raw && raw.trim().toLowerCase() === "auto") {
		const platformId =
			process.env.ELIZA_PLATFORM === "ios"
				? "ios"
				: process.env.ELIZA_PLATFORM === "android"
					? "android"
					: process.platform;
		return platformPlaybackDelaySamples(
			platformId,
			AUDIO_FRAME_PIPELINE_SAMPLE_RATE,
		);
	}
	const ms = Number(raw);
	if (!Number.isFinite(ms) || ms <= 0) return 0;
	return Math.round((ms / 1000) * AUDIO_FRAME_PIPELINE_SAMPLE_RATE);
}

function resolveResidualSuppression(): boolean | { gain: number } | undefined {
	const raw =
		process.env.ELIZA_VOICE_RESIDUAL_SUPPRESSION?.trim().toLowerCase();
	if (!raw) return undefined;
	if (raw === "1" || raw === "true" || raw === "on") return true;
	const gain = Number(raw);
	if (Number.isFinite(gain) && gain > 0 && gain <= 1) return { gain };
	return undefined;
}

function createAsrEchoCanceller(): NlmsEchoCanceller {
	const residualSuppression = resolveResidualSuppression();
	return new NlmsEchoCanceller(
		residualSuppression ? { residualSuppression } : {},
	);
}

export class FarEndEchoReference {
	private readonly echoBuffer = new EchoReferenceBuffer({
		sampleRateHz: AUDIO_FRAME_PIPELINE_SAMPLE_RATE,
	});
	private readonly canceller = createAsrEchoCanceller();
	private echoDelaySamples = resolveEchoDelaySamples();
	private echoDelayConfidence = 0;
	private echoDelayCalibrated = false;
	private playbackFramesReceived = 0;
	private playbackSamplesReceived = 0;
	private lastPlaybackFrameAt: number | null = null;
	private calNear: Float32Array[] = [];
	private calFar: Float32Array[] = [];
	private calSampleCount = 0;
	private asrFramesCancelled = 0;
	private lastAsrErleDb: number | null = null;

	pushPlayback(frames: AudioFrameEvent[]): void {
		for (const frame of frames) {
			const pcm = decodeAudioFramePcm(frame);
			this.echoBuffer.pushAt(frame.timestamp, pcm);
			this.playbackFramesReceived += 1;
			this.playbackSamplesReceived += pcm.length;
			this.lastPlaybackFrameAt = Date.now();
		}
	}

	resetPlayback(): void {
		this.echoBuffer.reset();
		this.canceller.reset();
		this.calNear = [];
		this.calFar = [];
		this.calSampleCount = 0;
		this.lastAsrErleDb = null;
	}

	status(): FarEndEchoReferenceStatus {
		return {
			echoReferenceWired: this.playbackSamplesReceived > 0,
			playbackFramesReceived: this.playbackFramesReceived,
			playbackSamplesReceived: this.playbackSamplesReceived,
			lastPlaybackFrameAt: this.lastPlaybackFrameAt,
			echoDelaySamples: this.echoDelaySamples,
			echoDelayConfidence: this.echoDelayConfidence,
			echoDelayCalibrated: this.echoDelayCalibrated,
			asrFramesCancelled: this.asrFramesCancelled,
			lastAsrErleDb: this.lastAsrErleDb,
		};
	}

	cancelAsrWav(
		audio: Uint8Array,
		options: AsrEchoCancellationOptions = {},
	): AsrEchoCancellationResult {
		const decoded = decodeMonoPcm16Wav(audio);
		if (decoded.sampleRate !== AUDIO_FRAME_PIPELINE_SAMPLE_RATE) {
			return {
				audio,
				applied: false,
				framesCancelled: 0,
				lastErleDb: this.lastAsrErleDb,
			};
		}
		const captureStartedAtMs = this.resolveCaptureStartMs(
			decoded.pcm.length,
			options,
		);
		if (!finiteNumber(captureStartedAtMs)) {
			this.canceller.observeFarEndSilence(decoded.pcm);
			return {
				audio,
				applied: false,
				framesCancelled: 0,
				lastErleDb: this.lastAsrErleDb,
			};
		}

		const out = new Float32Array(decoded.pcm.length);
		let framesCancelled = 0;
		let lastErleDb: number | null = null;
		for (
			let offset = 0;
			offset < decoded.pcm.length;
			offset += ASR_AEC_FRAME_SAMPLES
		) {
			const near = decoded.pcm.subarray(
				offset,
				Math.min(decoded.pcm.length, offset + ASR_AEC_FRAME_SAMPLES),
			);
			const timestampMs =
				captureStartedAtMs + (offset / AUDIO_FRAME_PIPELINE_SAMPLE_RATE) * 1000;
			this.observeForDelayCalibration(near, timestampMs);
			const far = this.echoBuffer.referenceAt(
				timestampMs,
				near.length,
				this.echoDelaySamples,
			);
			if (meanSquare(far) < ECHO_CAL_FAR_ENERGY_FLOOR) {
				this.canceller.observeFarEndSilence(near);
				out.set(near, offset);
				continue;
			}
			const cleaned = this.canceller.process(near, far);
			out.set(cleaned, offset);
			framesCancelled += 1;
			lastErleDb = computeErle(near, cleaned);
		}

		if (framesCancelled === 0) {
			return {
				audio,
				applied: false,
				framesCancelled: 0,
				lastErleDb: this.lastAsrErleDb,
			};
		}

		this.asrFramesCancelled += framesCancelled;
		this.lastAsrErleDb = lastErleDb;
		return {
			audio: encodeMonoPcm16Wav(out, decoded.sampleRate),
			applied: true,
			framesCancelled,
			lastErleDb,
		};
	}

	private resolveCaptureStartMs(
		samples: number,
		options: AsrEchoCancellationOptions,
	): number | null {
		if (finiteNumber(options.captureStartedAtMs)) {
			return options.captureStartedAtMs;
		}
		if (finiteNumber(options.captureEndedAtMs)) {
			return (
				options.captureEndedAtMs -
				(samples / AUDIO_FRAME_PIPELINE_SAMPLE_RATE) * 1000
			);
		}
		return null;
	}

	private observeForDelayCalibration(
		nearPcm: Float32Array,
		timestampMs: number,
	): void {
		if (this.echoDelayCalibrated || nearPcm.length === 0) return;
		const far = this.echoBuffer.referenceAt(timestampMs, nearPcm.length, 0);
		if (meanSquare(far) < ECHO_CAL_FAR_ENERGY_FLOOR) return;

		this.calNear.push(nearPcm.slice());
		this.calFar.push(far);
		this.calSampleCount += nearPcm.length;
		while (
			this.calSampleCount > ECHO_CAL_MAX_SAMPLES &&
			this.calNear.length > 1
		) {
			this.calSampleCount -= (this.calNear.shift() as Float32Array).length;
			this.calFar.shift();
		}
		if (this.calSampleCount < ECHO_CAL_TARGET_SAMPLES) return;

		const est = estimateEchoDelaySamples(
			concatFloat32(this.calNear),
			concatFloat32(this.calFar),
			{ maxLagSamples: ECHO_CAL_MAX_LAG_SAMPLES },
		);
		if (
			est.confidence >= ECHO_CAL_MIN_CONFIDENCE &&
			est.lagSamples < ECHO_CAL_MAX_LAG_SAMPLES - ECHO_CAL_CAP_EDGE_SAMPLES
		) {
			this.echoDelaySamples = est.lagSamples;
			this.echoDelayConfidence = est.confidence;
			this.echoDelayCalibrated = true;
		}
		this.calNear = [];
		this.calFar = [];
		this.calSampleCount = 0;
	}
}

let sharedFarEndEchoReference: FarEndEchoReference | null = null;

export function getSharedFarEndEchoReference(): FarEndEchoReference {
	sharedFarEndEchoReference ??= new FarEndEchoReference();
	return sharedFarEndEchoReference;
}

export function resetSharedFarEndEchoReferenceForTesting(): void {
	sharedFarEndEchoReference = new FarEndEchoReference();
}
