/**
 * Deterministic contract and seeded paging coverage for progressive content
 * views. Tests execute the exported validators/builders without adapter mocks.
 */

import { describe, expect, it } from "vitest";
import {
	buildContentReference,
	buildReadSlice,
	buildReadView,
	isReadView,
	validateReadView,
} from "./content.ts";

const HASH = "a".repeat(64);

describe("progressive content contract", () => {
	it("builds a complete empty view", () => {
		const view = buildReadView({
			reference: buildContentReference({ kind: "document", ref: "doc_123" }),
			slice: buildReadSlice({
				range: { unit: "fragment", start: 0, end: 0, total: 0 },
				completeness: "complete",
				sliceSha256: HASH,
				sourceSha256: HASH,
			}),
		});
		expect(view.slice).toMatchObject({
			hasPrevious: false,
			hasMore: false,
			completeness: "complete",
		});
		expect(view.slice.nextOffset).toBeUndefined();
		expect(isReadView(view)).toBe(true);
	});

	it("derives exact advancing continuation metadata", () => {
		const slice = buildReadSlice({
			range: { unit: "line", start: 25, end: 50, total: 75 },
			completeness: "partial-recoverable",
			sliceSha256: HASH,
			revision: "rev_2",
		});
		expect(slice).toMatchObject({
			hasPrevious: true,
			hasMore: true,
			nextOffset: 50,
		});
	});

	it("rejects hostile locator fields and false completeness", () => {
		expect(() =>
			validateReadView({
				reference: {
					kind: "file",
					ref: "opaque_1",
					path: "/private/secret",
				},
				slice: {
					range: { unit: "line", start: 0, end: 10, total: 20 },
					hasPrevious: false,
					hasMore: false,
					completeness: "complete",
					sliceSha256: HASH,
				},
			}),
		).toThrow(/unsupported field.*path/u);
	});

	it.each([
		"/private/secret",
		"user@example.com",
		"two words",
		"a".repeat(257),
	])("rejects a non-opaque model reference %s", (ref) => {
		expect(() => buildContentReference({ kind: "file", ref })).toThrow(
			/opaque token/u,
		);
	});

	it("rejects mismatched reference and slice revisions", () => {
		expect(() =>
			buildReadView({
				reference: { kind: "email", ref: "email:opaque_1", revision: "r1" },
				slice: buildReadSlice({
					range: { unit: "line", start: 0, end: 1, total: 2 },
					completeness: "partial-recoverable",
					sliceSha256: HASH,
					revision: "r2",
				}),
			}),
		).toThrow(/revisions must match/u);
	});

	it.each([
		{ start: -1, end: 1 },
		{ start: 2, end: 1 },
		{ start: Number.MAX_SAFE_INTEGER + 1, end: Number.MAX_SAFE_INTEGER + 1 },
	])("rejects invalid range %#", (range) => {
		expect(() =>
			buildReadSlice({
				range: { unit: "byte", ...range },
				completeness: "complete",
				sliceSha256: HASH,
			}),
		).toThrow(/Invalid progressive content contract/u);
	});

	it("requires revision identity for recoverable continuation", () => {
		expect(() =>
			buildReadSlice({
				range: { unit: "line", start: 0, end: 10, total: 20 },
				completeness: "partial-recoverable",
				sliceSha256: HASH,
			}),
		).toThrow(/require revision or sourceSha256/u);
	});

	it("seeded page boundaries reconstruct without gaps or overlap", () => {
		let seed = 0x5eed1234;
		const random = () => {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			return seed;
		};
		for (let trial = 0; trial < 250; trial++) {
			const total = random() % 10_000;
			const limit = (random() % 257) + 1;
			const ranges: Array<[number, number]> = [];
			for (let start = 0; start < total || (total === 0 && start === 0); ) {
				const end = Math.min(total, start + limit);
				const slice = buildReadSlice({
					range: { unit: "byte", start, end, total },
					completeness: end < total ? "partial-recoverable" : "complete",
					sliceSha256: HASH,
					revision: "fixed_revision",
				});
				ranges.push([slice.range.start, slice.range.end]);
				if (!slice.hasMore) break;
				start = slice.nextOffset as number;
			}
			expect(ranges[0]?.[0]).toBe(0);
			expect(ranges.at(-1)?.[1]).toBe(total);
			for (let index = 1; index < ranges.length; index++) {
				expect(ranges[index]?.[0]).toBe(ranges[index - 1]?.[1]);
			}
		}
	});
});
