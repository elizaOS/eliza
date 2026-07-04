/**
 * Unit tests for the structured error base — code/context/cause/severity
 * round-trip, instanceof across the class hierarchy, and the normalization
 * helper.
 */

import { describe, expect, it } from "vitest";
import { ElizaError, isElizaError, toElizaError } from "./errors";

describe("ElizaError", () => {
	it("round-trips code, context, severity, and message", () => {
		const err = new ElizaError("db query failed", {
			code: "DB_QUERY_FAILED",
			context: { table: "agents", op: "count" },
			severity: "fatal",
		});
		expect(err.message).toBe("db query failed");
		expect(err.code).toBe("DB_QUERY_FAILED");
		expect(err.context).toEqual({ table: "agents", op: "count" });
		expect(err.severity).toBe("fatal");
		expect(err.name).toBe("ElizaError");
	});

	it("preserves the cause chain on native .cause", () => {
		const root = new Error("connection refused");
		const err = new ElizaError("wrapped", { code: "WRAP", cause: root });
		expect(err.cause).toBe(root);
	});

	it("is an Error and an ElizaError under instanceof", () => {
		const err = new ElizaError("x", { code: "X" });
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(ElizaError);
		expect(isElizaError(err)).toBe(true);
		expect(isElizaError(new Error("plain"))).toBe(false);
	});

	it("supports subclassing with a preserved prototype chain", () => {
		class DbError extends ElizaError {}
		const err = new DbError("boom", { code: "DB" });
		expect(err).toBeInstanceOf(DbError);
		expect(err).toBeInstanceOf(ElizaError);
		expect(isElizaError(err)).toBe(true);
	});

	describe("toElizaError", () => {
		it("passes an existing ElizaError through unchanged", () => {
			const original = new ElizaError("x", { code: "X" });
			expect(toElizaError(original)).toBe(original);
		});

		it("wraps a native Error, preserving message and cause", () => {
			const native = new Error("kaboom");
			const wrapped = toElizaError(native, "FALLBACK");
			expect(wrapped).toBeInstanceOf(ElizaError);
			expect(wrapped.code).toBe("FALLBACK");
			expect(wrapped.message).toBe("kaboom");
			expect(wrapped.cause).toBe(native);
		});

		it("wraps a non-Error value with the default code", () => {
			const wrapped = toElizaError("string failure");
			expect(wrapped.code).toBe("UNCLASSIFIED");
			expect(wrapped.message).toBe("string failure");
			expect(wrapped.cause).toBe("string failure");
		});
	});
});
