/**
 * Unit tests for the structured error base — code/context/cause/severity
 * round-trip, instanceof across the class hierarchy, and the normalization
 * helper.
 */

import { describe, expect, it, vi } from "vitest";
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

	// `@elizaos/core` and `@elizaos/core/errors` are separate build entrypoints
	// that each inline this module, and the Cloud Worker bundle additionally
	// aliases `@elizaos/core` to a hand-written mirror. So a second, unrelated
	// `ElizaError` constructor is a shipped configuration, not a hypothetical.
	// `vi.resetModules()` reproduces exactly that: a fresh module instance with
	// its own class object.
	describe("across a second copy of this module", () => {
		const loadFreshCopy = async () => {
			vi.resetModules();
			return (await import("./errors")) as typeof import("./errors");
		};

		it("still narrows an ElizaError built by the other copy", async () => {
			const other = await loadFreshCopy();
			const foreign = new other.ElizaError("bounded body exceeded", {
				code: "CLOUD_REST_RESPONSE_TOO_LARGE",
				severity: "ephemeral",
			});

			// The premise: this really is a different class object.
			expect(other.ElizaError).not.toBe(ElizaError);
			expect(foreign instanceof ElizaError).toBe(false);

			expect(isElizaError(foreign)).toBe(true);
			expect(other.isElizaError(new ElizaError("local", { code: "X" }))).toBe(
				true,
			);
		});

		it("passes a foreign ElizaError through toElizaError unchanged", async () => {
			const other = await loadFreshCopy();
			const foreign = new other.ElizaError("bounded body exceeded", {
				code: "CLOUD_REST_RESPONSE_TOO_LARGE",
				severity: "ephemeral",
			});

			// Re-wrapping would replace a precise code with UNCLASSIFIED and
			// bury the real one on `.cause`.
			expect(toElizaError(foreign)).toBe(foreign);
			expect(toElizaError(foreign).code).toBe("CLOUD_REST_RESPONSE_TOO_LARGE");
		});

		it("does not brand unrelated errors or plain objects", async () => {
			expect(isElizaError(new Error("plain"))).toBe(false);
			expect(isElizaError({ code: "X", severity: "fatal" })).toBe(false);
			expect(isElizaError(null)).toBe(false);
			expect(isElizaError(undefined)).toBe(false);
		});

		it("keeps the brand off enumerable and serialized output", () => {
			const err = new ElizaError("db query failed", { code: "DB" });
			expect(Object.keys(err)).not.toContain(
				"Symbol(@elizaos/core:ElizaError)",
			);
			expect(Object.getOwnPropertyNames(err)).toEqual(
				expect.not.arrayContaining(["@elizaos/core:ElizaError"]),
			);
			expect(JSON.stringify({ ...err })).not.toContain(
				"elizaos/core:ElizaError",
			);
		});
	});
});
