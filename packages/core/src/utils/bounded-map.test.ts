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
		// The first `limit` calls are admitted synchronously; no more until one
		// of them settles.
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

	it("rejects as soon as one item fails, without waiting for a sibling still in flight", async () => {
		const g = gate();
		const started: string[] = [];
		let siblingSettled = false;
		const run = mapWithConcurrency(
			["held", "failing", "never-admitted"],
			2,
			async (item) => {
				started.push(item);
				if (item === "held") {
					await g.hold();
					siblingSettled = true;
					return item;
				}
				await new Promise((resolve) => setTimeout(resolve, 0));
				throw new Error(`${item} failed`);
			},
		);

		// The map must reject while the sibling is still held at the gate.
		await expect(run).rejects.toThrow("failing failed");
		expect(siblingSettled).toBe(false);
		expect(g.pending()).toBe(1);
		expect(started).toEqual(["held", "failing"]);

		// Releasing the sibling afterwards admits nothing further and surfaces
		// no second error.
		await g.releaseAll();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(siblingSettled).toBe(true);
		expect(started).toEqual(["held", "failing"]);
	});

	it("drops a later rejection from an item admitted before the first failure", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const run = mapWithConcurrency([1, 2], 2, async (item) => {
				await new Promise((resolve) => setTimeout(resolve, item));
				throw new Error(`item ${item} failed`);
			});
			await expect(run).rejects.toThrow("item 1 failed");
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("rejects when fn throws synchronously", async () => {
		await expect(
			mapWithConcurrency([1], 2, () => {
				throw new Error("sync boom");
			}),
		).rejects.toThrow("sync boom");
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
