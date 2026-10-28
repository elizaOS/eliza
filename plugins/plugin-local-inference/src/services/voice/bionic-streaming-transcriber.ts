/**
 * `StreamingTranscriber` over the bionic host's streaming ASR ops
 * (`asr_stream_*` on `ElizaBionicInferenceServer`, Phonon-2 / parakeet in
 * libelizainference). This is the Android path: the musl agent cannot load
 * the fused library, so PCM goes over the UDS to the app process.
 *
 * Frames are resampled to 16 kHz and queued. One serialized task chain
 * feeds the queue to the host and asks for a running partial whenever at
 * least `partialIntervalMs` of new audio has been fed; changed partials are
 * emitted as `partial` events (and the first words as `words`). `flush()`
 * runs on the same chain: it feeds what is left, calls finish, closes the
 * host stream and resolves the final transcript. The next frame opens a new
 * stream.
 *
 * Batch fallback happens only when the host reports that its ASR backend
 * cannot stream (`asr_stream_open` → `STREAM_UNSUPPORTED`, a host library
 * built without the Parakeet-TDT backend):
 * the segment's audio is then kept and transcribed with op="asr" on flush.
 * Any other failure surfaces from `flush()`; there is no silent degrade.
 *
 * Buffers are bounded: at most `maxQueuedSeconds` of audio waits for the
 * host (oldest audio is dropped beyond that and counted), and a segment is
 * capped at the host's 120 s stream limit. Logs carry counts and lengths,
 * never transcript text.
 */

import { logger } from "@elizaos/core";
import {
	BIONIC_ASR_STREAM_MAX_SECONDS,
	pcmToBase64LE,
} from "../bionic-asr-stream";
import {
	ASR_SAMPLE_RATE,
	BaseStreamingTranscriber,
	resampleLinear,
	type TranscriptMetadataDefaults,
} from "./transcriber";
import type {
	PcmFrame,
	TranscriptUpdate,
	VadEventSource,
	VoiceInputSource,
} from "./types";

/** The stream calls the transcriber needs (implemented by `BionicAsrStream`). */
export interface BionicAsrStreamHandle {
	feed(pcm: Float32Array): Promise<number>;
	partial(): Promise<string>;
	finish(): Promise<string>;
	cancel(): Promise<boolean>;
	close(): Promise<void>;
}

/** The host calls the transcriber needs (implemented by `BionicHostLoader`). */
export interface BionicAsrHost {
	/** Resolves null only when the host's ASR backend cannot stream. */
	openAsrStream(args: {
		sampleRate: number;
	}): Promise<BionicAsrStreamHandle | null>;
	transcribe(args: {
		pcmBase64: string;
		sampleRate: number;
		signal?: AbortSignal;
	}): Promise<string>;
}

export interface BionicStreamingTranscriberOptions {
	host: BionicAsrHost;
	vad?: VadEventSource;
	metadata?: TranscriptMetadataDefaults;
	source?: VoiceInputSource;
	/** New audio between partial requests. Default 320 ms. */
	partialIntervalMs?: number;
	/** Audio allowed to wait for the host before the oldest is dropped. Default 10 s. */
	maxQueuedSeconds?: number;
}

export const DEFAULT_BIONIC_PARTIAL_INTERVAL_MS = 320;
const DEFAULT_MAX_QUEUED_SECONDS = 10;

type Mode = "unknown" | "stream" | "batch";

export class BionicStreamingTranscriber extends BaseStreamingTranscriber {
	private readonly host: BionicAsrHost;
	private readonly partialStepSamples: number;
	private readonly maxQueuedSamples: number;
	private readonly maxSegmentSamples =
		BIONIC_ASR_STREAM_MAX_SECONDS * ASR_SAMPLE_RATE;

	private mode: Mode = "unknown";
	private chain: Promise<void> = Promise.resolve();
	private drainScheduled = false;
	private queue: Float32Array[] = [];
	private queuedSamples = 0;
	private droppedSamples = 0;

	// Per-segment state.
	private stream: BionicAsrStreamHandle | null = null;
	private segmentSamples = 0;
	private samplesSincePartial = 0;
	private lastPartial = "";
	private batchPcm: Float32Array[] = [];
	private failure: Error | null = null;
	private abort = new AbortController();
	private disposedFlag = false;

	constructor(opts: BionicStreamingTranscriberOptions) {
		super(opts.vad, {
			...opts.metadata,
			source: opts.metadata?.source ?? opts.source,
		});
		this.host = opts.host;
		const intervalMs =
			opts.partialIntervalMs ?? DEFAULT_BIONIC_PARTIAL_INTERVAL_MS;
		this.partialStepSamples = Math.max(
			1,
			Math.round((intervalMs / 1000) * ASR_SAMPLE_RATE),
		);
		this.maxQueuedSamples = Math.max(
			ASR_SAMPLE_RATE,
			Math.round(
				(opts.maxQueuedSeconds ?? DEFAULT_MAX_QUEUED_SECONDS) * ASR_SAMPLE_RATE,
			),
		);
	}

	/** "stream" once the host accepted a stream, "batch" after it reported none. */
	get backendMode(): Mode {
		return this.mode;
	}

	protected onFrame(frame: PcmFrame): void {
		const pcm = resampleLinear(frame.pcm, frame.sampleRate, ASR_SAMPLE_RATE);
		if (pcm.length === 0) return;
		this.queue.push(pcm);
		this.queuedSamples += pcm.length;
		while (
			this.queuedSamples > this.maxQueuedSamples &&
			this.queue.length > 1
		) {
			const dropped = this.queue.shift();
			if (!dropped) break;
			this.queuedSamples -= dropped.length;
			this.droppedSamples += dropped.length;
		}
		if (!this.drainScheduled) {
			this.drainScheduled = true;
			this.enqueue(async () => {
				this.drainScheduled = false;
				await this.drain();
			});
		}
	}

	protected onFlush(): Promise<TranscriptUpdate> {
		return new Promise<TranscriptUpdate>((resolve, reject) => {
			this.enqueue(async () => {
				try {
					resolve(await this.finishSegment());
				} catch (err) {
					reject(err);
				}
			});
		});
	}

	protected onDispose(): void {
		this.disposedFlag = true;
		this.abort.abort();
		this.queue = [];
		this.queuedSamples = 0;
		this.batchPcm = [];
		const stream = this.stream;
		this.stream = null;
		if (stream) {
			// Stop a decode in flight, then free the host stream.
			void stream.cancel().finally(() => void stream.close());
		}
	}

	private enqueue(task: () => Promise<void>): void {
		this.chain = this.chain.then(task).catch((err: unknown) => {
			this.recordFailure(err);
		});
	}

	private recordFailure(err: unknown): void {
		if (!this.failure) {
			this.failure = err instanceof Error ? err : new Error(String(err));
		}
	}

	private takeQueued(): Float32Array {
		const total = this.queuedSamples;
		const out = new Float32Array(total);
		let off = 0;
		for (const part of this.queue) {
			out.set(part, off);
			off += part.length;
		}
		this.queue = [];
		this.queuedSamples = 0;
		return out;
	}

	/** Feed queued audio and, when enough is new, emit a running partial. */
	private async drain(): Promise<void> {
		if (this.disposedFlag || this.failure || this.queuedSamples === 0) return;
		let pcm = this.takeQueued();
		const room = this.maxSegmentSamples - this.segmentSamples;
		if (pcm.length > room) {
			this.droppedSamples += pcm.length - Math.max(0, room);
			pcm = pcm.subarray(0, Math.max(0, room));
		}
		if (pcm.length === 0) return;
		this.segmentSamples += pcm.length;
		const stream = await this.ensureStream();
		if (this.disposedFlag) return;
		if (!stream) {
			this.batchPcm.push(pcm);
			return;
		}
		try {
			await stream.feed(pcm);
			this.samplesSincePartial += pcm.length;
			if (this.samplesSincePartial < this.partialStepSamples) return;
			this.samplesSincePartial = 0;
			const text = await stream.partial();
			if (this.disposedFlag) return;
			if (text !== this.lastPartial) {
				this.lastPartial = text;
				this.emitPartial({ partial: text, isFinal: false });
			}
		} catch (err) {
			// The host stream is unusable; drop it and fail the segment.
			this.stream = null;
			void stream.close();
			throw err;
		}
	}

	private async ensureStream(): Promise<BionicAsrStreamHandle | null> {
		if (this.mode === "batch") return null;
		if (this.stream) return this.stream;
		const stream = await this.host.openAsrStream({
			sampleRate: ASR_SAMPLE_RATE,
		});
		if (!stream) {
			this.mode = "batch";
			logger.info(
				"[asr] bionic host ASR backend does not stream; using batch op=asr per segment",
			);
			return null;
		}
		if (this.disposedFlag) {
			void stream.close();
			return null;
		}
		this.mode = "stream";
		this.stream = stream;
		return stream;
	}

	private resetSegment(): void {
		this.stream = null;
		this.segmentSamples = 0;
		this.samplesSincePartial = 0;
		this.lastPartial = "";
		this.batchPcm = [];
		this.failure = null;
		if (this.droppedSamples > 0) {
			logger.warn(
				`[asr] bionic stream dropped ${this.droppedSamples} samples (host behind or segment over ${BIONIC_ASR_STREAM_MAX_SECONDS} s)`,
			);
			this.droppedSamples = 0;
		}
	}

	private async finishSegment(): Promise<TranscriptUpdate> {
		// Whatever arrived since the last drain belongs to this segment.
		if (!this.failure && this.queuedSamples > 0) {
			try {
				await this.drain();
			} catch (err) {
				this.recordFailure(err);
			}
		}
		const failure = this.failure;
		const stream = this.stream;
		const batch = this.batchPcm;
		this.resetSegment();
		if (failure) {
			if (stream) void stream.close();
			throw failure;
		}
		if (stream) {
			try {
				const text = await stream.finish();
				logger.debug(`[asr] bionic stream final: ${text.length} chars`);
				return { partial: text, isFinal: true };
			} finally {
				await stream.close();
			}
		}
		if (batch.length === 0) return { partial: "", isFinal: true };
		let total = 0;
		for (const part of batch) total += part.length;
		const pcm = new Float32Array(total);
		let off = 0;
		for (const part of batch) {
			pcm.set(part, off);
			off += part.length;
		}
		const text = await this.host.transcribe({
			pcmBase64: pcmToBase64LE(pcm),
			sampleRate: ASR_SAMPLE_RATE,
			signal: this.abort.signal,
		});
		return { partial: text, isFinal: true };
	}
}

/**
 * Streaming transcriber for the Android bionic host: partials from the
 * host's streaming decoder, batch op="asr" only when the backend has none.
 */
export function createBionicStreamingTranscriber(
	opts: BionicStreamingTranscriberOptions,
): BionicStreamingTranscriber {
	return new BionicStreamingTranscriber(opts);
}
