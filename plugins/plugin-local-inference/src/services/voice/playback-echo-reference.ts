/**
 * Playback echo reference store (#9583, follow-up to #9455).
 *
 * The NLMS echo canceller in `echo-canceller.ts` needs the agent's TTS playback
 * PCM (the far-end reference) time-aligned to each mic frame so it can subtract
 * the agent's own voice from the mic before VAD/attribution. The canceller seam
 * in `audio-frame-consumer.ts` accepts an injected `EchoReferenceProvider`:
 *
 *     (timestampMs: number, samples: number) => Float32Array | null
 *
 * This store IS that provider. It is fed every TTS playback chunk the agent
 * hands to audio output — the same tap that feeds {@link AgentSelfVoiceImprint}
 * (`VoiceScheduler` `onAudio`) — and it answers a mic frame's `(timestampMs,
 * samples)` query with the playback PCM that was playing during that exact mic
 * window, or `null` when the agent was silent then.
 *
 * Clock domains. Playback PCM is observed in the playback wall clock; the mic
 * frame carries the capture (near-end) clock. Both are `Date.now()`-style ms on
 * the same device, so they share an origin, but the audio leaving the speaker
 * reaches the mic only after a fixed transport lag (audio-HAL buffering,
 * Bluetooth, resampling). `playbackToMicDelayMs` shifts the query window back by
 * that lag so the far-end aligns with the near-end the adaptive filter sees. The
 * per-platform value of that delay must be measured on hardware (the bulk-delay
 * calibration is the device-gated part of #9583 — `echo-delay.ts` estimates it
 * by cross-correlation); the default here is 0 (no pre-alignment), leaving the
 * adaptive taps to absorb the residual within their tail.
 *
 * Pure: no FFI, no fs, no network, no timers — it just buffers Float32 PCM and
 * answers windowed reads, so it runs in the fast unit-test lane like the
 * canceller it feeds. The caller owns the playback tap and the delay value.
 */

import { AUDIO_FRAME_PIPELINE_SAMPLE_RATE } from "./audio-frame-consumer.js";

export interface PlaybackEchoReferenceConfig {
	/**
	 * Sample rate the reference is dimensioned for (Hz). Must match the mic
	 * pipeline so a query's `samples` maps 1:1 to playback samples. Default
	 * 16000 (the only rate the on-device voice graphs accept).
	 */
	sampleRate?: number;
	/**
	 * Fixed playback→mic transport delay (ms): the bulk lag between a sample
	 * leaving the speaker and the mic capturing its echo. The query window is
	 * shifted back by this much so the returned far-end lines up with the
	 * near-end. Default 0 (no pre-alignment; the adaptive taps absorb the lag).
	 * The real per-platform value is tuned on a device (see `echo-delay.ts`).
	 */
	playbackToMicDelayMs?: number;
	/**
	 * Seconds of playback PCM retained. Bounds memory and caps how far back a
	 * late mic frame can be answered. Default 8 s — far longer than the
	 * canceller's tail plus any plausible transport delay, so an in-order mic
	 * frame is always covered while a long playback never grows unbounded.
	 */
	retentionSeconds?: number;
}

const DEFAULTS = {
	sampleRate: AUDIO_FRAME_PIPELINE_SAMPLE_RATE,
	playbackToMicDelayMs: 0,
	retentionSeconds: 8,
} as const;

/** One observed playback chunk, anchored to its playback-clock start time. */
interface PlaybackChunk {
	/** Playback-clock ms at which this chunk's first sample left the speaker. */
	startMs: number;
	/** Float32 PCM [-1, 1] at the store's sample rate. */
	pcm: Float32Array;
}

export class PlaybackEchoReference {
	private readonly sampleRate: number;
	private readonly playbackToMicDelayMs: number;
	private readonly retentionSamples: number;
	/** Observed playback chunks, oldest first, contiguous in playback time. */
	private readonly chunks: PlaybackChunk[] = [];
	private bufferedSamples = 0;
	/** Playback-clock ms of the first still-retained sample (chunks[0].startMs). */
	private get oldestMs(): number {
		return this.chunks.length > 0 ? this.chunks[0].startMs : 0;
	}

	constructor(config: PlaybackEchoReferenceConfig = {}) {
		this.sampleRate = config.sampleRate ?? DEFAULTS.sampleRate;
		this.playbackToMicDelayMs =
			config.playbackToMicDelayMs ?? DEFAULTS.playbackToMicDelayMs;
		const retentionSeconds =
			config.retentionSeconds ?? DEFAULTS.retentionSeconds;
		this.retentionSamples = Math.max(
			this.sampleRate,
			Math.round(retentionSeconds * this.sampleRate),
		);
	}

	/**
	 * Record one chunk of TTS playback PCM, anchored to the playback-clock ms at
	 * which its first sample is played. `sampleRate` must match the store's rate
	 * — a mismatch is a bug (the on-device pipeline is single-rate), not a thing
	 * to resample silently. Empty chunks are ignored.
	 */
	observePlayback(pcm: Float32Array, sampleRate: number, atMs: number): void {
		if (sampleRate !== this.sampleRate) {
			throw new Error(
				`[PlaybackEchoReference] expected ${this.sampleRate} Hz playback; got ${sampleRate} Hz`,
			);
		}
		if (pcm.length === 0) return;
		this.chunks.push({ startMs: atMs, pcm });
		this.bufferedSamples += pcm.length;
		this.evictOld();
	}

	/**
	 * The {@link EchoReferenceProvider} read: the playback PCM aligned to the mic
	 * window `[timestampMs, timestampMs + samples/sampleRate)`, or `null` when no
	 * playback covers it (agent silent → canceller passes the mic through).
	 *
	 * The mic window is shifted back by `playbackToMicDelayMs` to undo the bulk
	 * transport lag, then mapped onto the buffered playback timeline. A partial
	 * overlap is zero-padded to exactly `samples` (the leading/trailing silence
	 * is correct: nothing was playing there). A window with no overlap at all
	 * returns `null` so the canceller skips adaptation on a silent reference.
	 */
	reference(timestampMs: number, samples: number): Float32Array | null {
		if (samples <= 0 || this.chunks.length === 0) return null;
		const farStartMs = timestampMs - this.playbackToMicDelayMs;
		// Sample index of the window start on the playback timeline, relative to
		// the oldest retained sample.
		const startIdx = Math.round(
			((farStartMs - this.oldestMs) * this.sampleRate) / 1000,
		);
		const endIdx = startIdx + samples;
		// No overlap with the retained playback timeline → agent was silent.
		if (endIdx <= 0 || startIdx >= this.bufferedSamples) return null;

		const out = new Float32Array(samples);
		// Walk the contiguous chunks, copying the overlapping span of each into the
		// output at its window-relative offset. `cursor` is the playback-timeline
		// index of the current chunk's first sample.
		let cursor = 0;
		for (const chunk of this.chunks) {
			const chunkStart = cursor;
			const chunkEnd = cursor + chunk.pcm.length;
			cursor = chunkEnd;
			const overlapStart = Math.max(startIdx, chunkStart);
			const overlapEnd = Math.min(endIdx, chunkEnd);
			if (overlapEnd <= overlapStart) continue;
			out.set(
				chunk.pcm.subarray(overlapStart - chunkStart, overlapEnd - chunkStart),
				overlapStart - startIdx,
			);
		}
		return out;
	}

	/** Drop all buffered playback (call when playback stops / on a hard boundary). */
	reset(): void {
		this.chunks.length = 0;
		this.bufferedSamples = 0;
	}

	/** Retained playback samples (test/observability). */
	get samples(): number {
		return this.bufferedSamples;
	}

	/** Evict oldest whole chunks once the retained span exceeds the budget. */
	private evictOld(): void {
		while (
			this.chunks.length > 1 &&
			this.bufferedSamples - this.chunks[0].pcm.length >= this.retentionSamples
		) {
			const dropped = this.chunks.shift();
			if (dropped) this.bufferedSamples -= dropped.pcm.length;
		}
	}
}
