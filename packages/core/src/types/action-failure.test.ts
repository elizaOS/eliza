/**
 * Coverage for action-failure.
 */
import { describe, expect, it } from "vitest";
import {
	normalizeActionFailureProvenance,
	readActionFailureProvenance,
} from "./action-failure.js";

describe("action-failure", () => {
	it("normalizes valid provenance", () => {
		const r = normalizeActionFailureProvenance({
			kind: "handler_error",
			boundary: "handler",
			code: "ERR",
			retryable: true,
		});
		expect(r.kind).toBe("handler_error");
		expect(r.boundary).toBe("handler");
	});
	it("throws for invalid", () => {
		expect(() => normalizeActionFailureProvenance(null)).toThrow();
		expect(() =>
			normalizeActionFailureProvenance({
				kind: "bad",
				boundary: "handler",
				code: "x",
				retryable: true,
			}),
		).toThrow();
	});
	it("reads provenance from error", () => {
		expect(readActionFailureProvenance(null)).toBeNull();
		const err = {
			failureProvenance: {
				kind: "handler_error",
				boundary: "handler",
				code: "ERR",
				retryable: false,
			},
		};
		expect(readActionFailureProvenance(err)?.kind).toBe("handler_error");
	});
});
