import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger";
import { BrowserWorkspaceManager } from "./browser-workspace";

async function seed(
	manager: BrowserWorkspaceManager,
	count: number,
): Promise<void> {
	for (let i = 0; i < count; i += 1) {
		await manager.snapshotTab({ id: `missing-${i + 1}` });
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("BrowserWorkspaceManager.listEvents", () => {
	it("pages forward from the cursor without skipping events", async () => {
		const manager = new BrowserWorkspaceManager();
		await seed(manager, 10);

		const seen: number[] = [];
		let cursor = 0;
		for (let page = 0; page < 10; page += 1) {
			const result = await manager.listEvents({ after: cursor, limit: 3 });
			if (result.events.length === 0) break;
			seen.push(...result.events.map((event) => event.seq));
			cursor = result.latestSequence;
		}

		expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(cursor).toBe(10);
	});

	it("advances to the head when a filtered page is not truncated", async () => {
		const manager = new BrowserWorkspaceManager();
		await seed(manager, 5);
		const result = await manager.listEvents({
			after: 0,
			limit: 10,
			tabId: "missing-2",
		});
		expect(result.events.map((event) => event.seq)).toEqual([2]);
		expect(result.latestSequence).toBe(5);
	});

	it("bounds the event log and reports evictions with a logged counter", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const manager = new BrowserWorkspaceManager({ maxEvents: 4 });
		await seed(manager, 7);

		const result = await manager.listEvents();
		expect(result.events.map((event) => event.seq)).toEqual([4, 5, 6, 7]);
		expect(result.droppedEvents).toBe(3);
		expect(result.latestSequence).toBe(7);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("evicted 1");
	});

	it("rejects a non-positive event capacity", () => {
		expect(() => new BrowserWorkspaceManager({ maxEvents: 0 })).toThrow(
			TypeError,
		);
	});
});
