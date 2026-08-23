/**
 * Behavioral coverage for the managed-provider cursor pagination walker.
 * Exercises exhaustive traversal by default plus opaque cursor replay
 * protection, caller-selected page/item ceilings, and limit validation.
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

	it("collects more than 1000 items when no explicit ceiling is requested", async () => {
		let calls = 0;
		const fetchPage = async (cursor: string | undefined) => {
			calls += 1;
			const start = cursor === undefined ? 0 : Number(cursor);
			const count = start === 1_000 ? 101 : 500;
			return page(
				Array.from({ length: count }, (_, index) => start + index),
				start + count < 1_101 ? String(start + count) : null,
			);
		};
		await expect(collectProviderPages(fetchPage)).resolves.toHaveLength(1_101);
		expect(calls).toBe(3);
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
