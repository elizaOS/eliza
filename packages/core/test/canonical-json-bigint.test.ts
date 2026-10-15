import { describe, expect, it } from "vitest";
import {
	AGENT_BACKUP_CANONICAL_JSON,
	CANONICAL_JSON_UNBOUNDED,
	canonicalJsonString,
} from "../src/canonical-json.ts";
import { ElizaError } from "../src/errors.ts";

describe("canonical-json BigInt handling", () => {
	it("rejects a root BigInt through the typed onUnbounded hook", () => {
		let caught: unknown;
		try {
			canonicalJsonString(10n, AGENT_BACKUP_CANONICAL_JSON);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ElizaError);
		expect((caught as ElizaError).code).toBe(CANONICAL_JSON_UNBOUNDED);
	});

	it("rejects a nested BigInt instead of throwing a raw TypeError", () => {
		let caught: unknown;
		try {
			canonicalJsonString({ amount: 10n }, AGENT_BACKUP_CANONICAL_JSON);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ElizaError);
		expect((caught as ElizaError).code).toBe(CANONICAL_JSON_UNBOUNDED);
		// Must not be the raw "Do not know how to serialize a BigInt" TypeError.
		expect(caught).not.toBeInstanceOf(TypeError);
	});

	it("still serializes ordinary values", () => {
		expect(
			canonicalJsonString({ b: 1, a: "x" }, AGENT_BACKUP_CANONICAL_JSON),
		).toBe('{"a":"x","b":1}');
	});
});
