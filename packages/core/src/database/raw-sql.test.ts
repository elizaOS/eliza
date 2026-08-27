/**
 * Exercises the shared raw-SQL boundary against both supported driver result
 * envelopes, malformed database output, runtime capability probing, and SQL
 * literal encoding without replacing the boundary under test.
 */
import { describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../types/runtime.js";
import {
	executeRawSqlOnDb,
	extractRawSqlRows,
	getRuntimeRawSqlDb,
	parseRawSqlJsonArray,
	parseRawSqlJsonRecord,
	sqlInteger,
	sqlNumber,
	sqlQuote,
} from "./raw-sql.js";

const options = { subsystem: "RawSqlTest" };

describe("raw SQL boundary", () => {
	it("normalizes both supported driver result envelopes", () => {
		expect(extractRawSqlRows([{ id: "direct" }], options)).toEqual([
			{ id: "direct" },
		]);
		expect(extractRawSqlRows({ rows: [{ id: "wrapped" }] }, options)).toEqual([
			{ id: "wrapped" },
		]);
	});

	it("rejects malformed result envelopes and rows", () => {
		expect(() => extractRawSqlRows({}, options)).toThrowError(
			/unsupported raw-query result envelope/,
		);
		expect(() => extractRawSqlRows(["not-a-row"], options)).toThrowError(
			/non-object raw-query row/,
		);
	});

	it("executes Drizzle raw queries through the supplied database", async () => {
		let queryText = "";
		const rows = await executeRawSqlOnDb(
			{
				execute: async (query) => {
					queryText = query.queryChunks
						.map((chunk) => String(chunk.value ?? ""))
						.join("");
					return { rows: [{ ok: true }] };
				},
			},
			"SELECT 1",
			options,
		);
		expect(queryText).toContain("SELECT 1");
		expect(rows).toEqual([{ ok: true }]);
	});

	it("uses the adapter database and only probes runtime.db when requested", () => {
		const adapterDb = { execute: async () => [] };
		const runtimeDb = { execute: async () => [] };
		const runtime = {
			agentId: "00000000-0000-0000-0000-000000000001",
			adapter: { db: adapterDb },
			db: runtimeDb,
		} as unknown as IAgentRuntime;
		expect(getRuntimeRawSqlDb(runtime, options)).toBe(adapterDb);

		const runtimeOnly = {
			agentId: runtime.agentId,
			adapter: {},
			db: runtimeDb,
		} as unknown as IAgentRuntime;
		expect(() => getRuntimeRawSqlDb(runtimeOnly, options)).toThrowError(
			/adapter unavailable/,
		);
		expect(
			getRuntimeRawSqlDb(runtimeOnly, { ...options, allowRuntimeDb: true }),
		).toBe(runtimeDb);
	});

	it("parses JSON collections and rejects incompatible shapes", () => {
		expect(parseRawSqlJsonRecord('{"enabled":true}', options)).toEqual({
			enabled: true,
		});
		expect(parseRawSqlJsonArray<number>("[1,2]", options)).toEqual([1, 2]);
		expect(() => parseRawSqlJsonArray("{}", options)).toThrowError(
			/Expected JSON array/,
		);
	});

	it("escapes text and rejects non-finite numeric literals", () => {
		expect(sqlQuote("owner's")).toBe("'owner''s'");
		expect(sqlInteger(4.8)).toBe("4");
		expect(sqlNumber(1.25)).toBe("1.25");
		expect(() => sqlInteger(Number.NaN)).toThrowError(/invalid numeric/);
		expect(() => sqlNumber(Number.POSITIVE_INFINITY)).toThrowError(
			/invalid numeric/,
		);
	});
});
