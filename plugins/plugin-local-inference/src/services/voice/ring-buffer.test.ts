/** Covers `PcmRingBuffer` bulk-copy read/write and overflow signaling. Deterministic. */
import { describe, expect, it } from "vitest";
import { InMemoryAudioSink, PcmRingBuffer } from "./ring-buffer";

function f32(...xs: number[]): Float32Array {
	return Float32Array.from(xs);
}

/** Concatenate everything an InMemoryAudioSink received, in order. */
function sinkData(sink: InMemoryAudioSink): number[] {
	const out: number[] = [];
	for (const c of sink.chunks) out.push(...c.pcm);
	return out;
}

describe("PcmRingBuffer (bulk-copy)", () => {
	it("writes then flushes in FIFO order", () => {
		const sink = new InMemoryAudioSink();
		const rb = new PcmRingBuffer(8, 16000, sink);
		rb.write(f32(1, 2, 3));
		rb.write(f32(4, 5));
		expect(rb.size()).toBe(5);
		expect(rb.flushToSink()).toBe(5);
		expect(sinkData(sink)).toEqual([1, 2, 3, 4, 5]);
		expect(rb.size()).toBe(0);
	});

	it("handles a write that wraps the write cursor", () => {
		const sink = new InMemoryAudioSink();
		const rb = new PcmRingBuffer(4, 16000, sink);
		rb.write(f32(1, 2, 3)); // writePos=3
		expect(rb.flushToSink()).toBe(3); // readPos=writePos=3
		rb.write(f32(4, 5, 6)); // wraps: positions 3,0,1
		expect(rb.flushToSink()).toBe(3);
		expect(sinkData(sink)).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it("drops oldest samples on overflow and reports the count", () => {
		const sink = new InMemoryAudioSink();
		const dropped: number[] = [];
		const rb = new PcmRingBuffer(4, 16000, sink, {
			onOverflow: (n) => dropped.push(n),
		});
		rb.write(f32(1, 2, 3)); // filled=3
		rb.write(f32(4, 5, 6)); // filled would be 6 → drop 2 oldest (1,2)
		expect(dropped).toEqual([2]);
		expect(rb.size()).toBe(4);
		expect(rb.flushToSink()).toBe(4);
		expect(sinkData(sink)).toEqual([3, 4, 5, 6]);
	});

	it("keeps only the last `capacity` samples when one write exceeds capacity", () => {
		const sink = new InMemoryAudioSink();
		const dropped: number[] = [];
		const rb = new PcmRingBuffer(4, 16000, sink, {
			onOverflow: (n) => dropped.push(n),
		});
		rb.write(f32(1, 2, 3, 4, 5, 6, 7)); // 7 samples into cap-4 → keep 4,5,6,7
		expect(dropped).toEqual([3]);
		expect(rb.size()).toBe(4);
		rb.flushToSink();
		expect(sinkData(sink)).toEqual([4, 5, 6, 7]);
	});

	it("exact-capacity write fills without dropping", () => {
		const sink = new InMemoryAudioSink();
		const dropped: number[] = [];
		const rb = new PcmRingBuffer(4, 16000, sink, {
			onOverflow: (n) => dropped.push(n),
		});
		rb.write(f32(1, 2, 3, 4));
		expect(dropped).toEqual([]);
		expect(rb.size()).toBe(4);
		rb.flushToSink();
		expect(sinkData(sink)).toEqual([1, 2, 3, 4]);
	});

	it("partial overflow when already partly filled, with wrap", () => {
		const sink = new InMemoryAudioSink();
		const rb = new PcmRingBuffer(4, 16000, sink);
		rb.write(f32(1, 2)); // writePos=2, filled=2
		rb.write(f32(3, 4, 5)); // 3→pos2, 4→pos3, 5→pos0 (overwrites 1); drop 1
		// logical order now: 2,3,4,5
		expect(rb.size()).toBe(4);
		rb.flushToSink();
		expect(sinkData(sink)).toEqual([2, 3, 4, 5]);
	});

	it("pressure reflects fill ratio", () => {
		const rb = new PcmRingBuffer(10, 16000, new InMemoryAudioSink());
		expect(rb.pressure()).toBe(0);
		rb.write(f32(1, 2, 3, 4, 5));
		expect(rb.pressure()).toBeCloseTo(0.5);
	});

	it("drain clears without writing to the sink", () => {
		const sink = new InMemoryAudioSink();
		const rb = new PcmRingBuffer(4, 16000, sink);
		rb.write(f32(1, 2, 3));
		rb.drain();
		expect(rb.size()).toBe(0);
		expect(sinkData(sink)).toEqual([]);
	});

	it("empty write is a no-op", () => {
		const sink = new InMemoryAudioSink();
		const rb = new PcmRingBuffer(4, 16000, sink);
		rb.write(new Float32Array(0));
		expect(rb.size()).toBe(0);
		expect(rb.flushToSink()).toBe(0);
	});

	it("matches the reference per-sample model over a randomized-ish sequence", () => {
		// Reference oracle implemented straightforwardly; compare logical contents.
		const cap = 5;
		const sink = new InMemoryAudioSink();
		const rb = new PcmRingBuffer(cap, 16000, sink);
		const ref: number[] = [];
		const writes = [[1, 2], [3, 4, 5, 6], [7], [8, 9, 10, 11, 12, 13]];
		const value = 0;
		for (const w of writes) {
			void value;
			rb.write(Float32Array.from(w));
			ref.push(...w);
			while (ref.length > cap) ref.shift();
		}
		rb.flushToSink();
		expect(sinkData(sink)).toEqual(ref);
	});
});
