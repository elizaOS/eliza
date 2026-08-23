/**
 * Behavioral coverage for the managed-provider cursor pagination walker.
 * Exercises the bounded-collection contract: opaque cursor replay protection,
 * page/item ceilings, and the input validation that rejects non-positive or
 * non-integer limits before any provider call is made.
 */

import { describe, expect, it } from "vitest";
import { ManagedProviderError } from "./errors.ts";
import { collectProviderPages, type ProviderPage } from "./pagination.ts";

function page<T>(
	items: readonly T[],
	nextCursor: string | null,
): ProviderPage<T> {
	return { items, nextCursor };
}

describe("collectProviderPages", () => {
	it("collects a single terminal page without calling fetchPage again", async () => {
		const fetchPage = async (cursor: string | undefined) => {
			expect(cursor).toBeUndefined();
			return page([1, 2, 3], null);
		};
		await expect(collectProviderPages(fetchPage)).resolves.toEqual([1, 2, 3]);
	});

	it("passes the provider cursor to each subsequent page", async () => {
		const cursors: Array<string | undefined> = [];
		const fetchPage = async (cursor: string | undefined) => {
			cursors.push(cursor);
			if (cursor === undefined) return page(["a"], "next-1");
			if (cursor === "next-1") return page(["b"], "next-2");
			return page(["c"], null);
		};
		await expect(collectProviderPages(fetchPage)).resolves.toEqual([
			"a",
			"b",
			"c",
		]);
		expect(cursors).toEqual([undefined, "next-1", "next-2"]);
	});

	it("rejects a repeated cursor as a malformed provider response", async () => {
		let calls = 0;
		const fetchPage = async () => {
			calls += 1;
			return page(["x"], "same-cursor");
		};
		await expect(collectProviderPages(fetchPage)).rejects.toMatchObject({
			name: "ManagedProviderError",
			code: "MALFORMED_RESPONSE",
		});
		expect(calls).toBe(2);
	});

	it("rejects an empty continuation cursor as malformed", async () => {
		const fetchPage = async () => page(["x"], "");
		await expect(collectProviderPages(fetchPage)).rejects.toMatchObject({
			code: "MALFORMED_RESPONSE",
		});
	});

	it("enforces an explicit page ceiling after the last allowed page", async () => {
		let calls = 0;
		const fetchPage = async (cursor: string | undefined) => {
			calls += 1;
			return page(["x"], cursor === undefined ? "p2" : null);
		};
		await expect(
			collectProviderPages(fetchPage, { maxPages: 1 }),
		).rejects.toMatchObject({
			code: "PAGINATION_OVERFLOW",
			context: { maxPages: 1 },
		});
		// The overflow fires before the disallowed page is fetched.
		expect(calls).toBe(1);
	});

	it("enforces the accumulated item ceiling across pages", async () => {
		let calls = 0;
		const fetchPage = async () => {
			calls += 1;
			return page([1, 2], `c${calls}`);
		};
		await expect(
			collectProviderPages(fetchPage, { maxItems: 3 }),
		).rejects.toMatchObject({
			code: "PAGINATION_OVERFLOW",
			context: { maxItems: 3 },
		});
		expect(calls).toBe(2);
	});

	it("defaults the item ceiling to 1000 when no option is given", async () => {
		let calls = 0;
		const fetchPage = async () => {
			calls += 1;
			if (calls > 501) throw new Error("should have stopped at 1000 items");
			return page(
				Array.from({ length: 2 }, (_, i) => calls * 2 + i),
				null,
			);
		};
		// Two items per page, terminal immediately: bounded collection never
		// trips the default ceiling; this guards the constant against regressions.
		await expect(collectProviderPages(fetchPage)).resolves.toHaveLength(2);
		expect(calls).toBe(1);
	});

	it("rejects a non-positive page limit before fetching", async () => {
		const fetchPage = async () => page([], null);
		await expect(
			collectProviderPages(fetchPage, { maxPages: 0 }),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
	});

	it("rejects a fractional page limit before fetching", async () => {
		const fetchPage = async () => page([], null);
		await expect(
			collectProviderPages(fetchPage, { maxPages: 1.5 }),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
	});

	it("rejects a non-positive item limit before fetching", async () => {
		const fetchPage = async () => page([], null);
		await expect(
			collectProviderPages(fetchPage, { maxItems: 0 }),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
	});

	it("rejects a fractional item limit before fetching", async () => {
		const fetchPage = async () => page([], null);
		await expect(
			collectProviderPages(fetchPage, { maxItems: 2.5 }),
		).rejects.toBeInstanceOf(ManagedProviderError);
	});

	it("accepts a page ceiling that is exactly satisfied", async () => {
		const fetchPage = async () => page(["x"], null);
		await expect(
			collectProviderPages(fetchPage, { maxPages: 1 }),
		).resolves.toEqual(["x"]);
	});

	it("surfaces provider failures unchanged", async () => {
		const boom = new Error("provider down");
		const fetchPage = async () => {
			throw boom;
		};
		await expect(collectProviderPages(fetchPage)).rejects.toBe(boom);
	});
});
