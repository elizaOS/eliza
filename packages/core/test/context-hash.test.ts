/** Regression: stableJsonStringify must not erase Date values. */
import { describe, expect, test } from "vitest";
import {
	hashStableJson,
	stableJsonStringify,
} from "../src/runtime/context-hash";

describe("stableJsonStringify — Date values", () => {
	test("serializes a Date as its ISO string, like JSON.stringify", () => {
		expect(
			stableJsonStringify({ at: new Date("2024-01-01T00:00:00.000Z") }),
		).toBe('{"at":"2024-01-01T00:00:00.000Z"}');
	});

	test("distinct Dates hash distinctly and differ from an empty object", () => {
		const first = hashStableJson({
			at: new Date("2024-01-01T00:00:00.000Z"),
		});
		const second = hashStableJson({
			at: new Date("2025-06-01T00:00:00.000Z"),
		});
		expect(first).not.toBe(second);
		expect(first).not.toBe(hashStableJson({ at: {} }));
	});

	test("serializes a Date nested in an array", () => {
		expect(
			stableJsonStringify([new Date("2024-01-01T00:00:00.000Z")]),
		).toBe('["2024-01-01T00:00:00.000Z"]');
	});

	test("serializes an invalid Date as null, like JSON.stringify", () => {
		expect(stableJsonStringify({ at: new Date(Number.NaN) })).toBe(
			'{"at":null}',
		);
	});
});
