import { describe, expect, it } from "vitest";
import { LaunchStore } from "./launch-store";

function seed(store: LaunchStore, count: number): void {
	for (let i = 0; i < count; i += 1) store.recordEvent(`event-${i + 1}`);
}

describe("LaunchStore.tailEvents", () => {
	it("pages forward from the cursor without skipping events", () => {
		const store = new LaunchStore();
		seed(store, 10);

		const seen: number[] = [];
		let cursor = 0;
		for (let page = 0; page < 10; page += 1) {
			const result = store.tailEvents(cursor, 3);
			if (result.events.length === 0) break;
			seen.push(...result.events.map((event) => event.sequence));
			cursor = result.nextSequence;
		}

		expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(cursor).toBe(10);
	});

	it("returns the most recent events when no cursor is given", () => {
		const store = new LaunchStore();
		seed(store, 10);
		const result = store.tailEvents(undefined, 3);
		expect(result.events.map((event) => event.sequence)).toEqual([8, 9, 10]);
		expect(result.nextSequence).toBe(10);
	});

	it("returns an empty page and the head cursor when caught up", () => {
		const store = new LaunchStore();
		seed(store, 4);
		expect(store.tailEvents(4, 3)).toEqual({ events: [], nextSequence: 4 });
	});
});
