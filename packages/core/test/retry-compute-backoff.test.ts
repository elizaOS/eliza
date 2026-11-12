/** `computeBackoff` trusted its policy outright: a negative jitter, a
 * negative cap, or a NaN field produced a negative or NaN delay, and a
 * caller that sleeps that long waits nothing — the backoff does not back
 * off. The sibling `resolveRetryConfig` in the same file already clamps
 * every field; `computeBackoff` must do the same. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { computeBackoff } from "../src/utils/retry";

describe("computeBackoff invalid policy values", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function withRandom(value: number, run: () => void): void {
		vi.spyOn(Math, "random").mockReturnValue(value);
		run();
	}

	it("clamps a negative jitter to zero instead of returning a negative delay", () => {
		withRandom(1, () => {
			expect(
				computeBackoff(
					{ initialMs: 100, maxMs: 1000, factor: 2, jitter: -2 },
					1,
				),
			).toBe(100);
		});
	});

	it("clamps a jitter above one to one", () => {
		withRandom(1, () => {
			expect(
				computeBackoff(
					{ initialMs: 100, maxMs: 1000, factor: 2, jitter: 2 },
					1,
				),
			).toBe(200);
		});
	});

	it("returns zero instead of NaN for a NaN initial delay", () => {
		expect(
			computeBackoff({ initialMs: NaN, maxMs: 1000, factor: 2, jitter: 0 }, 1),
		).toBe(0);
	});

	it("returns zero instead of a negative delay for a negative cap", () => {
		expect(
			computeBackoff({ initialMs: 100, maxMs: -5, factor: 2, jitter: 0 }, 1),
		).toBe(0);
	});

	it("treats a NaN factor as no growth instead of returning NaN", () => {
		expect(
			computeBackoff(
				{ initialMs: 100, maxMs: 1000, factor: NaN, jitter: 0 },
				2,
			),
		).toBe(100);
	});

	it("treats a NaN attempt as the first attempt", () => {
		expect(
			computeBackoff(
				{ initialMs: 100, maxMs: 1000, factor: 2, jitter: 0 },
				NaN,
			),
		).toBe(100);
	});

	it("returns the cap instead of NaN when the base overflows with no jitter", () => {
		expect(
			computeBackoff(
				{ initialMs: 1e308, maxMs: 1000, factor: 10, jitter: 0 },
				2,
			),
		).toBe(1000);
		expect(
			computeBackoff(
				{ initialMs: 100, maxMs: 1000, factor: 2, jitter: -2 },
				1100,
			),
		).toBe(1000);
	});

	it("still applies jitter inside its documented range", () => {
		withRandom(1, () => {
			expect(
				computeBackoff(
					{ initialMs: 100, maxMs: 1000, factor: 2, jitter: 0.5 },
					1,
				),
			).toBe(150);
		});
	});

	it("still grows and caps delays for valid policies", () => {
		expect(
			computeBackoff({ initialMs: 100, maxMs: 1000, factor: 2, jitter: 0 }, 2),
		).toBe(200);
		expect(
			computeBackoff({ initialMs: 5000, maxMs: 100, factor: 2, jitter: 0 }, 1),
		).toBe(100);
	});
});
