/**
 * Unit tests for action-failure taxonomy: validates normalization
 * for missing_capability, handler_error, and persistence_error,
 * as well as reading provenance from thrown errors.
 */
import { describe, expect, it } from "vitest";
import {
	normalizeActionFailureProvenance,
	readActionFailureProvenance,
} from "./action-failure.ts";

describe("action-failure", () => {
	describe("normalizeActionFailureProvenance", () => {
		it("normalizes valid missing_capability provenance", () => {
			const res = normalizeActionFailureProvenance({
				kind: "missing_capability",
				boundary: "capability",
				code: "CAP_MISSING",
				retryable: false,
			});
			expect(res).toEqual({
				kind: "missing_capability",
				boundary: "capability",
				code: "CAP_MISSING",
				retryable: false,
			});
		});

		it("normalizes valid handler_error provenance", () => {
			const res = normalizeActionFailureProvenance({
				kind: "handler_error",
				boundary: "handler",
				code: "BAD_INPUT",
				retryable: true,
			});
			expect(res).toEqual({
				kind: "handler_error",
				boundary: "handler",
				code: "BAD_INPUT",
				retryable: true,
			});
		});

		it("normalizes valid persistence_error provenance", () => {
			const res = normalizeActionFailureProvenance({
				kind: "persistence_error",
				boundary: "persistence",
				code: "DB_TIMEOUT",
				retryable: true,
			});
			expect(res).toEqual({
				kind: "persistence_error",
				boundary: "persistence",
				code: "DB_TIMEOUT",
				retryable: true,
			});
		});

		it("throws TypeError on non-object or invalid fields", () => {
			expect(() => normalizeActionFailureProvenance(null)).toThrow(TypeError);
			expect(() => normalizeActionFailureProvenance("str")).toThrow(TypeError);
			expect(() =>
				normalizeActionFailureProvenance({
					kind: "missing_capability",
					code: "", // empty code
					boundary: "capability",
					retryable: false,
				}),
			).toThrow(TypeError);
			expect(() =>
				normalizeActionFailureProvenance({
					kind: "missing_capability",
					code: "CAP",
					boundary: "handler", // wrong boundary
					retryable: false,
				}),
			).toThrow(TypeError);
		});
	});

	describe("readActionFailureProvenance", () => {
		it("returns null for non-object errors or errors without provenance", () => {
			expect(readActionFailureProvenance(null)).toBeNull();
			expect(readActionFailureProvenance(new Error("simple error"))).toBeNull();
		});

		it("extracts provenance from error root or error.context", () => {
			const errWithDirect = {
				failureProvenance: {
					kind: "handler_error",
					boundary: "handler",
					code: "HANDLER_ERR",
					retryable: false,
				},
			};
			expect(readActionFailureProvenance(errWithDirect)?.code).toBe(
				"HANDLER_ERR",
			);

			const errWithContext = {
				context: {
					failureProvenance: {
						kind: "persistence_error",
						boundary: "persistence",
						code: "STORE_ERR",
						retryable: true,
					},
				},
			};
			expect(readActionFailureProvenance(errWithContext)?.code).toBe(
				"STORE_ERR",
			);
		});
	});
});
