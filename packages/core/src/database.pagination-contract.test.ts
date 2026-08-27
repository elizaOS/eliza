/**
 * Pins the portable pagination and ordering contract exported by database.ts.
 * These comparators and validators are the only rejection/ordering path for
 * task and entity queries across the in-memory adapter, plugin-sql, and the
 * agent memory browse API, so a shape, boundary, or tie-break regression would
 * silently change shipped pagination behavior at every consumer.
 *
 * Drives the real exported functions directly — no mocks, no database.
 */
import { describe, expect, it } from "vitest";

import {
	compareMemoryIds,
	compareTasksForQuery,
	validateQueryEntitiesPagination,
	validateTaskQueryPagination,
} from "./database";
import type { Task, UUID } from "./types";

const UUID_A = "11111111-1111-4111-8111-111111111111" as UUID;
const UUID_B = "22222222-2222-4222-8222-222222222222" as UUID;
const UUID_C = "33333333-3333-4333-8333-333333333333" as UUID;

function makeTask(overrides: Partial<Task> = {}): Task {
	return { name: "task", id: UUID_A, createdAt: 1_000, ...overrides };
}

describe("validateQueryEntitiesPagination", () => {
	it("accepts undefined and zero values", () => {
		expect(() => validateQueryEntitiesPagination({})).not.toThrow();
		expect(() =>
			validateQueryEntitiesPagination({ limit: 0, offset: 0 }),
		).not.toThrow();
	});

	it("throws a boundary-prefixed RangeError for negative values", () => {
		expect(() => validateQueryEntitiesPagination({ limit: -1 })).toThrow(
			new RangeError("queryEntities limit must be a non-negative safe integer"),
		);
		expect(() => validateQueryEntitiesPagination({ offset: -5 })).toThrow(
			new RangeError(
				"queryEntities offset must be a non-negative safe integer",
			),
		);
	});

	it("rejects fractional, NaN, Infinity, and non-integer values", () => {
		for (const bad of [
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		]) {
			expect(() => validateQueryEntitiesPagination({ limit: bad })).toThrow(
				RangeError,
			);
			expect(() => validateQueryEntitiesPagination({ offset: bad })).toThrow(
				RangeError,
			);
		}
	});

	it("does not confuse the queryEntities boundary with the getTasks boundary", () => {
		expect(() => validateQueryEntitiesPagination({ limit: -1 })).toThrow(
			/queryEntities/,
		);
		expect(() => validateQueryEntitiesPagination({ limit: -1 })).not.toThrow(
			/getTasks/,
		);
	});
});

describe("validateTaskQueryPagination", () => {
	it("accepts undefined and zero values", () => {
		expect(() => validateTaskQueryPagination({})).not.toThrow();
		expect(() =>
			validateTaskQueryPagination({ limit: 0, offset: 0 }),
		).not.toThrow();
	});

	it("throws a boundary-prefixed RangeError for negative values", () => {
		expect(() => validateTaskQueryPagination({ limit: -1 })).toThrow(
			new RangeError("getTasks limit must be a non-negative safe integer"),
		);
		expect(() => validateTaskQueryPagination({ offset: -5 })).toThrow(
			new RangeError("getTasks offset must be a non-negative safe integer"),
		);
	});

	it("rejects fractional, NaN, Infinity, and non-integer values", () => {
		for (const bad of [
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		]) {
			expect(() => validateTaskQueryPagination({ limit: bad })).toThrow(
				RangeError,
			);
			expect(() => validateTaskQueryPagination({ offset: bad })).toThrow(
				RangeError,
			);
		}
	});

	it("does not confuse the getTasks boundary with the queryEntities boundary", () => {
		expect(() => validateTaskQueryPagination({ limit: -1 })).toThrow(
			/getTasks/,
		);
		expect(() => validateTaskQueryPagination({ limit: -1 })).not.toThrow(
			/queryEntities/,
		);
	});
});

describe("compareMemoryIds", () => {
	it("orders ids case-insensitively like PostgreSQL uuid", () => {
		expect(compareMemoryIds(UUID_A, UUID_B)).toBeLessThan(0);
		expect(compareMemoryIds(UUID_B, UUID_A)).toBeGreaterThan(0);
	});

	it("treats mixed-case forms of the same id as equal", () => {
		const uppercase = UUID_A.toUpperCase() as UUID;
		expect(compareMemoryIds(UUID_A, uppercase)).toBe(0);
		expect(compareMemoryIds(uppercase, UUID_A)).toBe(0);
	});

	it("orders across the case boundary, not by raw byte value", () => {
		// 'a' sorts before 'B' in PostgreSQL uuid ordering after normalization.
		const lowerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
		const upperB = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB" as UUID;
		expect(compareMemoryIds(lowerA, upperB)).toBeLessThan(0);
	});

	it("is reflexive and antisymmetric", () => {
		expect(compareMemoryIds(UUID_C, UUID_C)).toBe(0);
		expect(compareMemoryIds(UUID_A, UUID_B)).toBe(
			-compareMemoryIds(UUID_B, UUID_A),
		);
	});
});

describe("compareTasksForQuery", () => {
	it("orders earlier createdAt first", () => {
		const earlier = makeTask({ id: UUID_A, createdAt: 1_000 });
		const later = makeTask({ id: UUID_B, createdAt: 2_000 });
		expect(compareTasksForQuery(earlier, later)).toBeLessThan(0);
		expect(compareTasksForQuery(later, earlier)).toBeGreaterThan(0);
	});

	it("ties break by normalized id", () => {
		const first = makeTask({ id: UUID_A, createdAt: 1_000 });
		const second = makeTask({ id: UUID_B, createdAt: 1_000 });
		expect(compareTasksForQuery(first, second)).toBeLessThan(0);
		expect(compareTasksForQuery(second, first)).toBeGreaterThan(0);
	});

	it("sorts undefined createdAt last regardless of id", () => {
		const without = makeTask({ id: UUID_A, createdAt: undefined });
		const withTime = makeTask({ id: UUID_B, createdAt: 1_000 });
		expect(compareTasksForQuery(without, withTime)).toBeGreaterThan(0);
		expect(compareTasksForQuery(withTime, without)).toBeLessThan(0);
		// Two undefined-createdAt tasks fall through to the id tie-break.
		expect(
			compareTasksForQuery(
				without,
				makeTask({ id: UUID_A, createdAt: undefined }),
			),
		).toBe(0);
	});

	it("normalizes id case in the tie-break", () => {
		const lower = makeTask({ id: UUID_A, createdAt: 1_000 });
		const upper = makeTask({
			id: UUID_A.toUpperCase() as UUID,
			createdAt: 1_000,
		});
		expect(compareTasksForQuery(lower, upper)).toBe(0);
	});
});
