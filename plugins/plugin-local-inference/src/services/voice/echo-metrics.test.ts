/** Unit tests for `computeErle` echo-return-loss-enhancement metrics. Deterministic. */
import { describe, expect, it } from "vitest";
import { computeErle } from "./echo-metrics";

describe("computeErle", () => {
	it("returns dB and handles edge cases", () => {
		const near = new Float32Array([1, 1, 1, 1]);
		const halfResidual = new Float32Array([0.5, 0.5, 0.5, 0.5]);

		expect(computeErle(near, halfResidual)).toBeCloseTo(6.0206, 2);
		expect(
			computeErle(new Float32Array([0, 0]), new Float32Array([1, 1])),
		).toBe(0);
		expect(
			computeErle(new Float32Array([1, 1]), new Float32Array([0, 0])),
		).toBe(Number.POSITIVE_INFINITY);
	});
});
