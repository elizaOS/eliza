/**
 * Fixed-capacity PCM ring buffer between the phrase scheduler and the audio
 * sink: writes wrap and overwrite the oldest unread samples, firing `onOverflow`
 * so the scheduler can apply upstream backpressure instead of glitching. Also
 * exports the in-memory sink used in tests.
 */
import type { AudioSink } from "./types";

export interface PcmRingBufferOptions {
	/**
	 * Fired when the buffer is full and a write overwrites unread samples.
	 * Reports the count of dropped samples in this write call. Schedulers
	 * should use this signal to apply backpressure upstream — silent
	 * overwrites produce audible glitches.
	 */
	onOverflow?: (droppedSamples: number) => void;
}

export class PcmRingBuffer {
	private readonly buf: Float32Array;
	private readPos = 0;
	private writePos = 0;
	private filled = 0;
	private readonly onOverflow?: (droppedSamples: number) => void;

	constructor(
		private readonly capacity: number,
		private readonly sampleRate: number,
		private readonly sink: AudioSink,
		options: PcmRingBufferOptions = {},
	) {
		if (capacity <= 0) {
			throw new Error("PcmRingBuffer: capacity must be positive");
		}
		this.buf = new Float32Array(capacity);
		this.onOverflow = options.onOverflow;
	}

	write(pcm: Float32Array): void {
		const n = pcm.length;
		if (n === 0) return;
		// Samples lost to overwrite: everything past capacity once we account for
		// what's already buffered. Matches the per-sample loop's drop accounting.
		const dropped = Math.max(0, this.filled + n - this.capacity);

		if (n >= this.capacity) {
			// The incoming chunk alone fills (or overfills) the ring — only its last
			// `capacity` samples survive. Bulk-copy them and reset to a full buffer.
			this.buf.set(pcm.subarray(n - this.capacity, n), 0);
			this.readPos = 0;
			this.writePos = 0;
			this.filled = this.capacity;
		} else {
			// Up to two contiguous bulk copies (one before the wrap, one after).
			const firstSpan = Math.min(n, this.capacity - this.writePos);
			this.buf.set(pcm.subarray(0, firstSpan), this.writePos);
			if (n > firstSpan) this.buf.set(pcm.subarray(firstSpan, n), 0);
			this.writePos = (this.writePos + n) % this.capacity;
			if (dropped > 0) {
				// Buffer overran: the read cursor chases the write cursor.
				this.readPos = (this.readPos + dropped) % this.capacity;
				this.filled = this.capacity;
			} else {
				this.filled += n;
			}
		}

		if (dropped > 0 && this.onOverflow) {
			this.onOverflow(dropped);
		}
	}

	/** Fill ratio in [0, 1]. Schedulers can throttle TTS dispatches as this approaches 1. */
	pressure(): number {
		return this.filled / this.capacity;
	}

	flushToSink(): number {
		if (this.filled === 0) return 0;
		const n = this.filled;
		const out = new Float32Array(n);
		// Read `n` samples from readPos with at most one wrap — two bulk copies.
		const firstSpan = Math.min(n, this.capacity - this.readPos);
		out.set(this.buf.subarray(this.readPos, this.readPos + firstSpan), 0);
		if (n > firstSpan) out.set(this.buf.subarray(0, n - firstSpan), firstSpan);
		this.readPos = this.writePos;
		this.filled = 0;
		this.sink.write(out, this.sampleRate);
		return n;
	}

	drain(): void {
		this.readPos = this.writePos;
		this.filled = 0;
		this.sink.drain();
	}

	size(): number {
		return this.filled;
	}

	capacityHint(): number {
		return this.capacity;
	}
}

export class InMemoryAudioSink implements AudioSink {
	readonly chunks: Array<{ pcm: Float32Array; sampleRate: number }> = [];
	private buffered = 0;

	write(pcm: Float32Array, sampleRate: number): void {
		this.chunks.push({ pcm, sampleRate });
		this.buffered += pcm.length;
	}

	drain(): void {
		this.buffered = 0;
	}

	bufferedSamples(): number {
		return this.buffered;
	}

	totalWritten(): number {
		let n = 0;
		for (const c of this.chunks) n += c.pcm.length;
		return n;
	}
}
