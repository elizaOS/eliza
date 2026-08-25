/**
 * Unit coverage for SingleFlightMemo in single-flight-memo.ts.
 *
 * Tests in-flight query sharing, TTL expiration in peek(), LRU max-entries eviction,
 * rejection self-eviction, and explicit key / all-keys invalidation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SingleFlightMemo } from "./single-flight-memo.js";

describe("SingleFlightMemo", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("stores and retrieves active entries via peek before TTL expiration", () => {
		const memo = new SingleFlightMemo<string, { size: number }>(1000, 10);
		const promise = Promise.resolve("data");

		const returned = memo.put("key1", { size: 42 }, promise);
		expect(returned).toBe(promise);

		const live = memo.peek("key1");
		expect(live).toBeDefined();
		expect(live?.meta.size).toBe(42);
		expect(live?.promise).toBe(promise);
	});

	it("returns null from peek when entry has expired past TTL", () => {
		const memo = new SingleFlightMemo<string, undefined>(500, 10);
		memo.put("key1", undefined, Promise.resolve("val"));

		expect(memo.peek("key1")).not.toBeNull();

		vi.advanceTimersByTime(501);

		expect(memo.peek("key1")).toBeNull();
	});

	it("evicts oldest entry when maxEntries boundary is reached", () => {
		const memo = new SingleFlightMemo<string, undefined>(1000, 2);

		memo.put("a", undefined, Promise.resolve("A"));
		memo.put("b", undefined, Promise.resolve("B"));

		expect(memo.peek("a")).not.toBeNull();
		expect(memo.peek("b")).not.toBeNull();

		// Inserting 3rd entry evicts 'a'
		memo.put("c", undefined, Promise.resolve("C"));

		expect(memo.peek("a")).toBeNull();
		expect(memo.peek("b")).not.toBeNull();
		expect(memo.peek("c")).not.toBeNull();
	});

	it("self-evicts rejected promises so failures are not resident", async () => {
		const memo = new SingleFlightMemo<string, undefined>(1000, 10);
		const rejectedPromise = Promise.reject(new Error("fetch failed"));

		memo.put("failKey", undefined, rejectedPromise);
		expect(memo.peek("failKey")).not.toBeNull();

		// Catch the rejection
		await rejectedPromise.catch(() => {});

		expect(memo.peek("failKey")).toBeNull();
	});

	it("invalidates specific keys and clears all entries when key is omitted", () => {
		const memo = new SingleFlightMemo<string, undefined>(1000, 10);

		memo.put("k1", undefined, Promise.resolve("1"));
		memo.put("k2", undefined, Promise.resolve("2"));

		memo.invalidate("k1");
		expect(memo.peek("k1")).toBeNull();
		expect(memo.peek("k2")).not.toBeNull();

		memo.invalidate();
		expect(memo.peek("k2")).toBeNull();
	});
});
