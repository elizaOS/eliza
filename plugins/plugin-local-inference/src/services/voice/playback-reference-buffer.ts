/**
 * playback-reference-buffer.ts — the caller-side far-end (agent TTS playback)
 * store that feeds the live acoustic echo canceller (#9583, follow-up to #9455).
 *
 * The {@link NlmsEchoCanceller} in `audio-frame-consumer.ts` needs the agent's
 * TTS playback PCM time-aligned to each mic frame so it can subtract the agent's
 * own voice before VAD / ASR / diarization. The canceller seam is ready; the
 * caller must SUPPLY that reference. This module is that supply: a small
 * ring of timestamped far-end PCM chunks that the on-device playback-capture
 * path writes into, plus a factory that turns the ring into the
 * {@link EchoReferenceProvider} the consumer consumes.
 *
 * Clock model: both the mic frames (`AudioFrameEvent.timestamp`) and the
 * playback chunks are stamped in the SAME device monotonic-clock domain (ms).
 * "What was playing at mic-clock time T" is answered by {@link
 * PlaybackReferenceBuffer.read}. The bulk playback→mic acoustic+transport delay
 * is NOT modeled here — it is applied by {@link createEchoReferenceProvider}
 * (`delaySamples`), so the NLMS taps only have to model the short residual room
 * impulse. That delay is what {@link estimatePlaybackDelaySamples} calibrates.
 *
 * Gaps (the agent speaks in bursts) are first-class: a `read` window that no
 * stored playback overlaps returns `null`, which the consumer treats as "agent
 * silent → pass the mic through unchanged". Out-of-order and partially-covered
 * windows are handled by integer sample-overlap math, so this never aliases one
 * burst's audio into a later burst's silence.
 *
 * Pure data structure, zero dependencies — verified by
 * playback-reference-buffer.test.ts.
 */

import {
	AUDIO_FRAME_PIPELINE_SAMPLE_RATE,
	type EchoReferenceProvider,
} from "./audio-frame-consumer.js";

/** One contiguous span of far-end playback PCM, stamped in the mic clock. */
interface PlaybackChunk {
	/** Device-clock timestamp (ms) of this chunk's first sample. */
	startMs: number;
	/** Absolute sample index of the first sample (round(startMs/1000 * SR)). */
	startSample: number;
	/** Far-end PCM, Float32 [-1, 1] @ 16 kHz. */
	pcm: Float32Array;
}

export interface PlaybackReferenceBufferOptions {
	/**
	 * Retained far-end history in seconds. Reads older than this are dropped, so
	 * the buffer cannot grow without bound while the agent talks. Default 8 s —
	 * comfortably covers the largest plausible playback→mic delay plus the NLMS
	 * filter span and a few mic frames of jitter.
	 */
	historySeconds?: number;
}

/**
 * A bounded, timestamped ring of the agent's far-end (TTS playback) PCM.
 *
 * Writers (the device playback-capture path) call {@link write} with each
 * playback block and the device-clock time it began playing. The echo canceller
 * (via {@link createEchoReferenceProvider}) calls {@link read} once per mic
 * frame to fetch the far-end window aligned to that frame.
 */
export class PlaybackReferenceBuffer {
	private readonly sampleRate = AUDIO_FRAME_PIPELINE_SAMPLE_RATE;
	private readonly maxSamples: number;
	/** Oldest-first chunks; total retained samples capped at `maxSamples`. */
	private chunks: PlaybackChunk[] = [];
	private retainedSamples = 0;

	constructor(opts: PlaybackReferenceBufferOptions = {}) {
		const seconds = Math.max(0.5, opts.historySeconds ?? 8);
		this.maxSamples = Math.round(seconds * this.sampleRate);
	}

	/** Total far-end samples currently retained (diagnostics). */
	get bufferedSamples(): number {
		return this.retainedSamples;
	}

	/**
	 * Append a far-end playback block that began playing at `startMs`
	 * (device monotonic clock, ms). Non-contiguous writes are fine — a gap
	 * between the previous chunk's end and `startMs` is real silence and is
	 * preserved as "no coverage", not zero-filled.
	 */
	write(pcm: Float32Array, startMs: number): void {
		if (pcm.length === 0) return;
		const startSample = Math.round((startMs / 1000) * this.sampleRate);
		// Drop a write that is entirely older than the retained window — it can
		// never be read (the mic frame that needed it has long passed).
		const newestSample = this.newestSample();
		if (
			newestSample !== null &&
			startSample + pcm.length <= newestSample - this.maxSamples
		) {
			return;
		}
		this.chunks.push({ startMs, startSample, pcm });
		this.retainedSamples += pcm.length;
		this.evictOldest();
	}

	/**
	 * Return the far-end PCM covering the mic-clock window
	 * `[startMs, startMs + samples/SR*1000)`. Covered samples are filled from the
	 * stored playback; gaps (silence) stay zero. Returns `null` when NO stored
	 * playback overlaps the window — the agent was silent and the mic should pass
	 * through unchanged.
	 */
	read(startMs: number, samples: number): Float32Array | null {
		if (samples <= 0) return null;
		const qStart = Math.round((startMs / 1000) * this.sampleRate);
		const qEnd = qStart + samples;
		const out = new Float32Array(samples);
		let covered = false;
		for (const chunk of this.chunks) {
			const cStart = chunk.startSample;
			const cEnd = cStart + chunk.pcm.length;
			const lo = Math.max(qStart, cStart);
			const hi = Math.min(qEnd, cEnd);
			if (lo >= hi) continue; // no overlap
			out.set(chunk.pcm.subarray(lo - cStart, hi - cStart), lo - qStart);
			covered = true;
		}
		return covered ? out : null;
	}

	/** Drop all retained playback (e.g. on a hard capture boundary). */
	clear(): void {
		this.chunks = [];
		this.retainedSamples = 0;
	}

	private newestSample(): number | null {
		const last = this.chunks[this.chunks.length - 1];
		return last ? last.startSample + last.pcm.length : null;
	}

	private evictOldest(): void {
		while (
			this.chunks.length > 1 &&
			this.retainedSamples - this.chunks[0].pcm.length >= this.maxSamples
		) {
			const dropped = this.chunks.shift();
			if (dropped) this.retainedSamples -= dropped.pcm.length;
		}
	}
}

export interface EchoReferenceProviderOptions {
	/**
	 * Bulk playback→mic delay in samples. The echo in the mic at time T was
	 * played `delaySamples` earlier, so the reference for a mic frame at T is the
	 * playback at `T − delaySamples`. Seed from {@link
	 * PLATFORM_PLAYBACK_DELAY_DEFAULTS} and refine with {@link
	 * estimatePlaybackDelaySamples}. Default 0 (the NLMS taps then absorb the
	 * whole short delay themselves).
	 */
	delaySamples?: number;
}

/**
 * Build the {@link EchoReferenceProvider} the {@link AudioFrameConsumer} wants
 * from a {@link PlaybackReferenceBuffer}. The provider applies the bulk
 * playback→mic delay (`delaySamples`) by reading the playback window from
 * `delaySamples` earlier than the mic frame, so the canceller's adaptive taps
 * only model the residual room impulse — not the transport latency.
 *
 * `delaySamples` may be a live getter so a re-calibration takes effect without
 * rebuilding the provider.
 */
export function createEchoReferenceProvider(
	buffer: PlaybackReferenceBuffer,
	opts:
		| EchoReferenceProviderOptions
		| (() => EchoReferenceProviderOptions) = {},
): EchoReferenceProvider {
	const resolve = typeof opts === "function" ? opts : () => opts;
	const delayMsOf = (delaySamples: number): number =>
		(delaySamples / AUDIO_FRAME_PIPELINE_SAMPLE_RATE) * 1000;
	return (timestampMs: number, samples: number): Float32Array | null => {
		const delaySamples = Math.max(0, Math.floor(resolve().delaySamples ?? 0));
		return buffer.read(timestampMs - delayMsOf(delaySamples), samples);
	};
}
