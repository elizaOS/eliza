/**
 * Echo-reference alignment buffer (#9583, follow-up to #9455/#9586).
 *
 * The NLMS echo canceller's `process(nearEnd, farEnd)` needs the far-end
 * (the agent's TTS playback) **time-aligned** to the current mic frame: the
 * echo in `nearEnd[t]` is the room-filtered playback from `t − delay`, where
 * `delay` is the bulk playback→mic transport delay (estimated by
 * {@link estimateEchoDelaySamples} in `echo-delay.ts`).
 *
 * The caller renders playback PCM in real time and `push()`es it here as it goes;
 * per mic frame it then asks for the aligned far-end slice. This is the
 * "caller must supply the reference" primitive the consumer seam was missing —
 * a fixed-capacity delay line, pure logic (no FFI, no device, no audio I/O).
 * Samples not yet rendered, or already evicted past capacity, are zero-filled
 * (no echo reference ⇒ the adaptive filter simply has nothing to cancel there).
 */

export interface EchoReferenceBufferOptions {
	/**
	 * Ring-buffer capacity in samples. Must comfortably exceed
	 * `maxDelaySamples + frameLength`. Default 24000 (1.5 s @ 16 kHz).
	 */
	capacitySamples?: number;
}

export class EchoReferenceBuffer {
	private readonly buffer: Float32Array;
	private readonly capacity: number;
	/** Total samples ever pushed (monotonic); the logical "now" cursor. */
	private pushed = 0;

	constructor(options: EchoReferenceBufferOptions = {}) {
		this.capacity = Math.max(1, Math.floor(options.capacitySamples ?? 24000));
		this.buffer = new Float32Array(this.capacity);
	}

	/** Append rendered playback (far-end) PCM as it is produced. */
	push(playback: Float32Array): void {
		for (let i = 0; i < playback.length; i++) {
			this.buffer[(this.pushed + i) % this.capacity] = playback[i];
		}
		this.pushed += playback.length;
	}

	/**
	 * The far-end reference frame aligned to a mic frame of `length` samples
	 * captured `delaySamples` after the corresponding playback. Returns the
	 * playback window `[pushed − delaySamples − length, pushed − delaySamples)`.
	 * Indices before the retained window (not yet pushed, or evicted past
	 * capacity) are zero-filled.
	 */
	referenceFor(length: number, delaySamples: number): Float32Array {
		const out = new Float32Array(Math.max(0, Math.floor(length)));
		const delay = Math.max(0, Math.floor(delaySamples));
		// Absolute index (in the monotonic stream) of the first output sample.
		const start = this.pushed - delay - out.length;
		const oldest = Math.max(0, this.pushed - this.capacity);
		for (let i = 0; i < out.length; i++) {
			const abs = start + i;
			// Available only if within [oldest, pushed) — else leave the 0 fill.
			if (abs >= oldest && abs >= 0 && abs < this.pushed) {
				out[i] = this.buffer[abs % this.capacity];
			}
		}
		return out;
	}

	/** Samples pushed so far (the monotonic stream position). */
	get position(): number {
		return this.pushed;
	}

	/** Drop all buffered playback (e.g. on a new turn / barge-in flush). */
	reset(): void {
		this.buffer.fill(0);
		this.pushed = 0;
	}
}
