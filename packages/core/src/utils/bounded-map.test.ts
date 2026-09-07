/**
 * Pins mapWithConcurrency's admission bound, ordering, and failure
 * propagation. Deterministic: in-flight calls are released by explicit
 * resolvers rather than timers.
 */
import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./bounded-map.ts";

function gate() {
	const releases: Array<() => void> = [];
	return {
		hold: () =>
			new Promise<void>((resolve) => {
				releases.push(resolve);
			}),
		releaseAll: async () => {
			while (releases.length > 0) {
				releases.shift()?.();
				await Promise.resolve();
			}
		},
		pending: () => releases.length,
	};
}

describe("mapWithConcurrency", () => {
	it("never admits more than the limit and keeps input order", async () => {
		const g = gate();
		let inFlight = 0;
		let peak = 0;
		const items = Array.from({ length: 23 }, (_unused, i) => i);
		const run = mapWithConcurrency(items, 4, async (item) => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await g.hold();
			inFlight -= 1;
			return item * 10;
		});
		// Let the workers start; only the first `limit` calls may be waiting.
		await Promise.resolve();
		expect(g.pending()).toBe(4);
		while (inFlight > 0 || g.pending() > 0) {
			await g.releaseAll();
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		const results = await run;
		expect(peak).toBe(4);
		expect(results).toEqual(items.map((i) => i * 10));
	});

	it("returns an empty array for an empty input without calling fn", async () => {
		let calls = 0;
		const results = await mapWithConcurrency([], 3, async () => {
			calls += 1;
			return 1;
		});
		expect(results).toEqual([]);
		expect(calls).toBe(0);
	});

	it("uses fewer workers than the limit when the input is shorter", async () => {
		let inFlight = 0;
		let peak = 0;
		const results = await mapWithConcurrency([1, 2], 8, async (item) => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 0));
			inFlight -= 1;
			return item;
		});
		expect(results).toEqual([1, 2]);
		expect(peak).toBe(2);
	});

	it("rejects with the first failure and stops admitting new items", async () => {
		const started: number[] = [];
		const run = mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (item) => {
			started.push(item);
			await new Promise((resolve) => setTimeout(resolve, 0));
			if (item === 1) {
				throw new Error(`item ${item} failed`);
			}
			return item;
		});
		await expect(run).rejects.toThrow("item 1 failed");
		// Items 0 and 1 were admitted first; the worker that hit the failure
		// stops, and the surviving worker drains at most what it had claimed.
		expect(started).not.toContain(5);
	});

	it("rejects a non-positive or fractional limit", async () => {
		await expect(mapWithConcurrency([1], 0, async (x) => x)).rejects.toThrow(
			RangeError,
		);
		await expect(mapWithConcurrency([1], 1.5, async (x) => x)).rejects.toThrow(
			RangeError,
		);
	});
});
