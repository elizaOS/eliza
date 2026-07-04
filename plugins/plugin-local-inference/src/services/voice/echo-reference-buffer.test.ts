/** Covers the AEC far-end reference buffer (#9583). Deterministic. */
import { describe, expect, it } from "vitest";
import { EchoReferenceBuffer } from "./echo-reference-buffer.ts";

/** Ramp where sample i has value i+1 (so 0 = "not filled"). */
function ramp(from: number, count: number): Float32Array {
	const out = new Float32Array(count);
	for (let i = 0; i < count; i++) out[i] = from + i + 1;
	return out;
}

describe("EchoReferenceBuffer (#9583)", () => {
	it("returns the last `length` samples at zero delay", () => {
		const buf = new EchoReferenceBuffer({ capacitySamples: 1000 });
		buf.push(ramp(0, 500)); // values 1..500
		const ref = buf.referenceFor(4, 0);
		expect(Array.from(ref)).toEqual([497, 498, 499, 500]);
	});

	it("shifts the window back by the delay", () => {
		const buf = new EchoReferenceBuffer({ capacitySamples: 1000 });
		buf.push(ramp(0, 500)); // values 1..500
		// delay 10 → window ends at sample (500-10)=490 → [487,488,489,490]
		expect(Array.from(buf.referenceFor(4, 10))).toEqual([487, 488, 489, 490]);
	});

	it("zero-fills samples not yet pushed (delay+length exceeds stream)", () => {
		const buf = new EchoReferenceBuffer({ capacitySamples: 1000 });
		buf.push(ramp(0, 3)); // values 1,2,3
		// length 5, delay 0 → window [-2,3): two leading zeros then 1,2,3
		expect(Array.from(buf.referenceFor(5, 0))).toEqual([0, 0, 1, 2, 3]);
	});

	it("zero-fills the part evicted past capacity", () => {
		const buf = new EchoReferenceBuffer({ capacitySamples: 8 });
		buf.push(ramp(0, 12)); // values 1..12; only the last 8 (5..12) retained
		// delay 0, length 8 → the retained window is values 5..12
		expect(Array.from(buf.referenceFor(8, 0))).toEqual([
			5, 6, 7, 8, 9, 10, 11, 12,
		]);
		// Asking for 10 reaches before the retained window → 2 leading zeros.
		expect(Array.from(buf.referenceFor(10, 0))).toEqual([
			0, 0, 5, 6, 7, 8, 9, 10, 11, 12,
		]);
	});

	it("accumulates across multiple pushes and tracks position", () => {
		const buf = new EchoReferenceBuffer({ capacitySamples: 1000 });
		buf.push(ramp(0, 100));
		buf.push(ramp(100, 100)); // values 101..200, position now 200
		expect(buf.position).toBe(200);
		expect(Array.from(buf.referenceFor(3, 0))).toEqual([198, 199, 200]);
	});

	it("reset clears the buffer", () => {
		const buf = new EchoReferenceBuffer({ capacitySamples: 1000 });
		buf.push(ramp(0, 50));
		buf.reset();
		expect(buf.position).toBe(0);
		expect(Array.from(buf.referenceFor(3, 0))).toEqual([0, 0, 0]);
	});

	it("preserves timestamp gaps between playback bursts", () => {
		const buf = new EchoReferenceBuffer({
			capacitySamples: 4000,
			sampleRateHz: 16_000,
		});
		buf.pushAt(1000, ramp(0, 4)); // samples 0..3
		buf.pushAt(1100, ramp(100, 4)); // samples 1600..1603

		expect(Array.from(buf.referenceAt(1000, 4, 0))).toEqual([1, 2, 3, 4]);
		expect(Array.from(buf.referenceAt(1050, 4, 0))).toEqual([0, 0, 0, 0]);
		expect(Array.from(buf.referenceAt(1100, 4, 0))).toEqual([
			101, 102, 103, 104,
		]);
	});

	it("applies delay to timestamp-aligned reads", () => {
		const buf = new EchoReferenceBuffer({
			capacitySamples: 1000,
			sampleRateHz: 16_000,
		});
		buf.pushAt(0, ramp(0, 10));

		expect(Array.from(buf.referenceAt(0.25, 4, 2))).toEqual([3, 4, 5, 6]);
	});
});
