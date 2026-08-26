/** Deterministic unit coverage for PriorityQueue ordering, overflow, and drain. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../logger.js";
import {
	PriorityQueue,
	type PriorityQueueOptions,
	type QueuePriority,
} from "./priority-queue";

type Item = {
	id: string;
	priority: QueuePriority | string;
};

function item(id: string, priority: QueuePriority | string): Item {
	return { id, priority };
}

function makeQueue(
	options: Omit<PriorityQueueOptions<Item>, "getPriority"> & {
		getPriority?: PriorityQueueOptions<Item>["getPriority"];
	} = {},
): PriorityQueue<Item> {
	return new PriorityQueue<Item>({
		getPriority: (queued) => queued.priority as QueuePriority,
		...options,
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("PriorityQueue", () => {
	it("starts empty with zeroed stats", () => {
		const queue = makeQueue();
		expect(queue.size).toBe(0);
		expect(queue.stats()).toEqual({ high: 0, normal: 0, low: 0, total: 0 });
		expect(queue.dequeueBatch(1)).toEqual([]);
		expect(queue.drain()).toEqual([]);
	});

	it("enqueues and dequeues a single element by identity", () => {
		const queue = makeQueue();
		const only = item("only", "normal");
		expect(queue.enqueue(only)).toBe(true);
		expect(queue.size).toBe(1);
		expect(queue.stats()).toEqual({ high: 0, normal: 1, low: 0, total: 1 });

		const drained = queue.dequeueBatch(1);
		expect(drained).toEqual([only]);
		expect(drained[0]).toBe(only);
		expect(queue.size).toBe(0);
	});

	it("dequeues high before normal before low regardless of enqueue order", () => {
		const queue = makeQueue();
		queue.enqueue(item("low-first", "low"));
		queue.enqueue(item("normal-mid", "normal"));
		queue.enqueue(item("high-last", "high"));
		queue.enqueue(item("low-second", "low"));
		queue.enqueue(item("high-second", "high"));

		expect(queue.dequeueBatch(5).map((queued) => queued.id)).toEqual([
			"high-last",
			"high-second",
			"normal-mid",
			"low-first",
			"low-second",
		]);
		expect(queue.size).toBe(0);
	});

	it("preserves FIFO order for items that share a priority (ties)", () => {
		const queue = makeQueue();
		queue.enqueue(item("n1", "normal"));
		queue.enqueue(item("n2", "normal"));
		queue.enqueue(item("n3", "normal"));

		expect(queue.dequeueBatch(2).map((queued) => queued.id)).toEqual([
			"n1",
			"n2",
		]);
		expect(queue.dequeueBatch(1).map((queued) => queued.id)).toEqual(["n3"]);
	});

	it("returns [] for non-positive dequeue counts and for an empty queue", () => {
		const queue = makeQueue();
		expect(queue.dequeueBatch(0)).toEqual([]);
		expect(queue.dequeueBatch(-3)).toEqual([]);

		queue.enqueue(item("kept", "high"));
		expect(queue.dequeueBatch(0)).toEqual([]);
		expect(queue.dequeueBatch(-1)).toEqual([]);
		expect(queue.size).toBe(1);
		expect(queue.dequeueBatch(1).map((queued) => queued.id)).toEqual(["kept"]);
	});

	it("returns every remaining item when n is larger than size", () => {
		const queue = makeQueue();
		queue.enqueue(item("h", "high"));
		queue.enqueue(item("l", "low"));
		expect(queue.dequeueBatch(99).map((queued) => queued.id)).toEqual([
			"h",
			"l",
		]);
		expect(queue.size).toBe(0);
		expect(queue.dequeueBatch(1)).toEqual([]);
	});

	it("skips empty higher buckets and continues into lower ones", () => {
		const queue = makeQueue();
		queue.enqueue(item("only-low", "low"));
		expect(queue.dequeueBatch(1).map((queued) => queued.id)).toEqual([
			"only-low",
		]);

		queue.enqueue(item("only-normal", "normal"));
		expect(queue.dequeueBatch(1).map((queued) => queued.id)).toEqual([
			"only-normal",
		]);
	});

	it("drains a mixed batch across high, then normal, then low in one call", () => {
		const queue = makeQueue();
		queue.enqueue(item("h1", "high"));
		queue.enqueue(item("n1", "normal"));
		queue.enqueue(item("n2", "normal"));
		queue.enqueue(item("l1", "low"));

		expect(queue.dequeueBatch(3).map((queued) => queued.id)).toEqual([
			"h1",
			"n1",
			"n2",
		]);
		expect(queue.dequeueBatch(1).map((queued) => queued.id)).toEqual(["l1"]);
	});

	it("rejects the new item when at maxSize and onPressure returns false", () => {
		const rejected: string[] = [];
		const queue = makeQueue({
			maxSize: 1,
			onPressure: (_queue, incoming) => {
				rejected.push(incoming.id);
				return false;
			},
		});
		const first = item("kept", "low");
		expect(queue.enqueue(first)).toBe(true);
		expect(queue.enqueue(item("dropped", "high"))).toBe(false);
		expect(rejected).toEqual(["dropped"]);
		expect(queue.size).toBe(1);
		expect(queue.drain()).toEqual([first]);
	});

	it("still enqueues when onPressure returns true without making room", () => {
		const queue = makeQueue({
			maxSize: 1,
			onPressure: () => true,
		});
		expect(queue.enqueue(item("a", "normal"))).toBe(true);
		expect(queue.enqueue(item("b", "normal"))).toBe(true);
		expect(queue.size).toBe(2);
		expect(queue.stats().total).toBe(2);
	});

	it("lets onPressure dequeue to make room, then inserts the new item", () => {
		const queue = makeQueue({
			maxSize: 2,
			onPressure: (live) => {
				live.dequeueBatch(1);
				return true;
			},
		});
		queue.enqueue(item("old-low", "low"));
		queue.enqueue(item("kept-low", "low"));
		expect(queue.enqueue(item("new-high", "high"))).toBe(true);
		expect(queue.size).toBe(2);
		expect(queue.dequeueBatch(2).map((queued) => queued.id)).toEqual([
			"new-high",
			"kept-low",
		]);
	});

	it("grows past maxSize and warns when there is no onPressure handler", () => {
		const warnings: Array<{ sizeAfter: number; maxSize: number }> = [];
		const queue = makeQueue({
			maxSize: 2,
			onOverflowWarning: (sizeAfter, maxSize) => {
				warnings.push({ sizeAfter, maxSize });
			},
		});
		expect(queue.enqueue(item("a", "high"))).toBe(true);
		expect(queue.enqueue(item("b", "high"))).toBe(true);
		expect(warnings).toEqual([]);

		expect(queue.enqueue(item("c", "low"))).toBe(true);
		expect(warnings).toEqual([{ sizeAfter: 3, maxSize: 2 }]);
		expect(queue.size).toBe(3);
		expect(queue.stats()).toEqual({ high: 2, normal: 0, low: 1, total: 3 });

		expect(queue.enqueue(item("d", "normal"))).toBe(true);
		expect(warnings).toEqual([
			{ sizeAfter: 3, maxSize: 2 },
			{ sizeAfter: 4, maxSize: 2 },
		]);
		expect(queue.size).toBe(4);
	});

	it("still enqueues past maxSize when neither onPressure nor onOverflowWarning is set", () => {
		const queue = makeQueue({ maxSize: 1 });
		expect(queue.enqueue(item("a", "normal"))).toBe(true);
		expect(queue.enqueue(item("b", "normal"))).toBe(true);
		expect(queue.size).toBe(2);
	});

	it("does not invoke overflow hooks while size is below maxSize", () => {
		const pressure: string[] = [];
		const warnings: Array<{ sizeAfter: number; maxSize: number }> = [];
		const queue = makeQueue({
			maxSize: 3,
			onPressure: (_queue, incoming) => {
				pressure.push(incoming.id);
				return false;
			},
			onOverflowWarning: (sizeAfter, maxSize) => {
				warnings.push({ sizeAfter, maxSize });
			},
		});
		queue.enqueue(item("a", "high"));
		queue.enqueue(item("b", "high"));
		expect(pressure).toEqual([]);
		expect(warnings).toEqual([]);
		expect(queue.size).toBe(2);
	});

	it("prefers onPressure over onOverflowWarning when both are set", () => {
		const warnings: number[] = [];
		const queue = makeQueue({
			maxSize: 1,
			onPressure: () => false,
			onOverflowWarning: (sizeAfter) => {
				warnings.push(sizeAfter);
			},
		});
		expect(queue.enqueue(item("kept", "low"))).toBe(true);
		expect(queue.enqueue(item("dropped", "high"))).toBe(false);
		expect(warnings).toEqual([]);
		expect(queue.size).toBe(1);
	});

	it("hits pressure on the first enqueue when maxSize is 0", () => {
		const pressure: string[] = [];
		const queue = makeQueue({
			maxSize: 0,
			onPressure: (_queue, incoming) => {
				pressure.push(incoming.id);
				return false;
			},
		});
		expect(queue.enqueue(item("never", "high"))).toBe(false);
		expect(pressure).toEqual(["never"]);
		expect(queue.size).toBe(0);
	});

	it("drain() with no filter returns high then normal then low and empties the queue", () => {
		const queue = makeQueue();
		queue.enqueue(item("n", "normal"));
		queue.enqueue(item("h", "high"));
		queue.enqueue(item("l", "low"));

		expect(queue.drain().map((queued) => queued.id)).toEqual(["h", "n", "l"]);
		expect(queue.size).toBe(0);
		expect(queue.stats()).toEqual({ high: 0, normal: 0, low: 0, total: 0 });
	});

	it("drain(filter) removes matching items and keeps the rest in priority order", () => {
		const queue = makeQueue();
		queue.enqueue(item("h1", "high"));
		queue.enqueue(item("h2", "high"));
		queue.enqueue(item("n1", "normal"));
		queue.enqueue(item("l1", "low"));
		queue.enqueue(item("l2", "low"));

		const removed = queue.drain((queued) => queued.id.endsWith("1"));
		expect(removed.map((queued) => queued.id)).toEqual(["h1", "n1", "l1"]);
		expect(queue.size).toBe(2);
		expect(queue.stats()).toEqual({ high: 1, normal: 0, low: 1, total: 2 });
		expect(queue.drain().map((queued) => queued.id)).toEqual(["h2", "l2"]);
	});

	it("drain(filter) for a missing item leaves the queue unchanged", () => {
		const queue = makeQueue();
		const kept = item("present", "normal");
		queue.enqueue(kept);

		expect(queue.drain((queued) => queued.id === "absent")).toEqual([]);
		expect(queue.size).toBe(1);
		expect(queue.drain()).toEqual([kept]);
	});

	it("drain(filter) matching every item empties the queue", () => {
		const queue = makeQueue();
		queue.enqueue(item("h", "high"));
		queue.enqueue(item("l", "low"));
		expect(queue.drain(() => true).map((queued) => queued.id)).toEqual([
			"h",
			"l",
		]);
		expect(queue.size).toBe(0);
	});

	it("clear() drops every bucket and later enqueues start empty", () => {
		const queue = makeQueue();
		queue.enqueue(item("h", "high"));
		queue.enqueue(item("n", "normal"));
		queue.enqueue(item("l", "low"));
		queue.clear();
		expect(queue.size).toBe(0);
		expect(queue.stats()).toEqual({ high: 0, normal: 0, low: 0, total: 0 });
		expect(queue.dequeueBatch(1)).toEqual([]);

		queue.enqueue(item("after", "low"));
		expect(queue.dequeueBatch(1).map((queued) => queued.id)).toEqual(["after"]);
	});

	it("treats an invalid getPriority result as normal and warns once", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
		const queue = makeQueue();
		expect(queue.enqueue(item("bad-1", "urgent"))).toBe(true);
		expect(queue.enqueue(item("bad-2", "critical"))).toBe(true);
		expect(queue.enqueue(item("good", "high"))).toBe(true);
		expect(queue.enqueue(item("real-normal", "normal"))).toBe(true);

		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			{ src: "utils:priority-queue", priority: "urgent" },
			'Invalid queue priority; expected "high" | "normal" | "low". Treating as normal.',
		);
		expect(queue.stats()).toEqual({ high: 1, normal: 3, low: 0, total: 4 });
		expect(queue.dequeueBatch(4).map((queued) => queued.id)).toEqual([
			"good",
			"bad-1",
			"bad-2",
			"real-normal",
		]);
	});

	it("warns independently on a second queue instance", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
		const first = makeQueue();
		const second = makeQueue();
		first.enqueue(item("a", "nope"));
		second.enqueue(item("b", "nope"));
		expect(warn).toHaveBeenCalledTimes(2);
		expect(first.stats().normal).toBe(1);
		expect(second.stats().normal).toBe(1);
	});
});
