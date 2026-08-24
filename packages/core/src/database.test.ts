/**
 * Exercises the shared helpers on the adapter base module: the two pagination
 * validators' accept/reject matrix, the PostgreSQL-order UUID comparators, and
 * `DatabaseAdapter`'s fail-closed defaults (`updatePendingTask` and the
 * optional connector-account/OAuth domains). Deterministic — pure functions
 * plus prototype defaults, no database, model, or filesystem involved.
 */
import { describe, expect, it } from "vitest";
import {
	compareMemoryIds,
	compareTasksForQuery,
	DatabaseAdapter,
	validateQueryEntitiesPagination,
	validateTaskQueryPagination,
} from "./database.ts";
import type { Task } from "./types.ts";

const LOWER_A = "9f1c3e22-8f0e-4c1d-9b2a-111111111111";
const UPPER_A = "9F1C3E22-8F0E-4C1D-9B2A-111111111111";
const LOWER_B = "a0c4d526-91af-4d22-8c31-222222222222";

function task(id: string | undefined, createdAt?: number | bigint): Task {
	return { id, name: "task", createdAt };
}

describe("validateQueryEntitiesPagination", () => {
	it("accepts unset, zero, and largest-safe values", () => {
		expect(() => validateQueryEntitiesPagination({})).not.toThrow();
		expect(() =>
			validateQueryEntitiesPagination({ limit: 0, offset: 0 }),
		).not.toThrow();
		expect(() =>
			validateQueryEntitiesPagination({
				limit: Number.MAX_SAFE_INTEGER,
				offset: Number.MAX_SAFE_INTEGER,
			}),
		).not.toThrow();
	});

	it("rejects negative values naming the offending field", () => {
		expect(() => validateQueryEntitiesPagination({ limit: -1 })).toThrow(
			new RangeError("queryEntities limit must be a non-negative safe integer"),
		);
		expect(() => validateQueryEntitiesPagination({ offset: -5 })).toThrow(
			new RangeError(
				"queryEntities offset must be a non-negative safe integer",
			),
		);
	});

	it("rejects fractional and beyond-safe values", () => {
		expect(() => validateQueryEntitiesPagination({ limit: 1.5 })).toThrow(
			RangeError,
		);
		expect(() => validateQueryEntitiesPagination({ offset: 2 ** 53 })).toThrow(
			RangeError,
		);
	});
});

describe("validateTaskQueryPagination", () => {
	it("accepts unset and valid values", () => {
		expect(() => validateTaskQueryPagination({})).not.toThrow();
		expect(() =>
			validateTaskQueryPagination({ limit: 10, offset: 20 }),
		).not.toThrow();
	});

	it("rejects invalid values with the getTasks boundary prefix", () => {
		expect(() => validateTaskQueryPagination({ limit: -1 })).toThrow(
			new RangeError("getTasks limit must be a non-negative safe integer"),
		);
		expect(() => validateTaskQueryPagination({ offset: 0.25 })).toThrow(
			new RangeError("getTasks offset must be a non-negative safe integer"),
		);
	});
});

describe("compareMemoryIds", () => {
	it("treats hexadecimal case as insignificant for equality", () => {
		expect(compareMemoryIds(LOWER_A, LOWER_A)).toBe(0);
		expect(compareMemoryIds(LOWER_A, UPPER_A)).toBe(0);
		expect(compareMemoryIds(UPPER_A, LOWER_A)).toBe(0);
	});

	it("orders distinct ids by their normalized bytes", () => {
		expect(compareMemoryIds(LOWER_A, LOWER_B)).toBe(-1);
		expect(compareMemoryIds(LOWER_B, UPPER_A)).toBe(1);
	});
});

describe("compareTasksForQuery", () => {
	it("orders by createdAt ascending in either argument order", () => {
		const earlier = task("id-earlier", 1_000);
		const later = task("id-later", 2_000);
		expect(compareTasksForQuery(earlier, later)).toBe(-1);
		expect(compareTasksForQuery(later, earlier)).toBe(1);
	});

	it("compares bigint and numeric createdAt on the same scale", () => {
		const bigintCreated = task("id-bigint", 1_000n);
		const numericCreated = task("id-numeric", 2_000);
		expect(compareTasksForQuery(bigintCreated, numericCreated)).toBe(-1);
		expect(compareTasksForQuery(numericCreated, bigintCreated)).toBe(1);
	});

	it("breaks createdAt ties through case-insensitive id order", () => {
		expect(compareTasksForQuery(task(UPPER_A, 5), task(LOWER_B, 5))).toBe(-1);
		expect(compareTasksForQuery(task(LOWER_B, 5), task(LOWER_A, 5))).toBe(1);
		expect(compareTasksForQuery(task(LOWER_A, 5), task(UPPER_A, 5))).toBe(0);
	});

	it("sorts tasks without createdAt after dated tasks", () => {
		const dated = task("id-dated", 1);
		const undated = task("id-undated");
		expect(compareTasksForQuery(dated, undated)).toBe(-1);
		expect(compareTasksForQuery(undated, dated)).toBe(1);
	});

	it("falls back to id order when neither task is dated", () => {
		expect(compareTasksForQuery(task(UPPER_A), task(LOWER_B))).toBe(-1);
		expect(compareTasksForQuery(task(undefined), task(LOWER_B))).toBe(-1);
		expect(compareTasksForQuery(task(undefined), task(undefined))).toBe(0);
	});
});

describe("DatabaseAdapter fail-closed defaults", () => {
	const adapter = Object.create(DatabaseAdapter.prototype) as DatabaseAdapter;

	it("fails closed on the optional pending-task transition", async () => {
		await expect(adapter.updatePendingTask(LOWER_A, {})).resolves.toBe(false);
	});

	it("rejects optional connector-account domains at the adapter level", () => {
		expect(() => adapter.listConnectorAccounts()).toThrow(
			"Database adapter does not support connector account storage",
		);
		expect(() => adapter.getConnectorAccount({})).toThrow(
			"connector account storage",
		);
	});

	it("rejects optional OAuth flow-state domains at the adapter level", () => {
		expect(() => adapter.getOAuthFlowState({})).toThrow(
			"Database adapter does not support connector account storage",
		);
		expect(() => adapter.deleteOAuthFlowState({})).toThrow(
			"connector account storage",
		);
	});
});
