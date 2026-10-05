/**
 * A shared non-cyclic reference (the same object reachable from two keys) must
 * be preserved by diagnostic serialization; only true cycles collapse.
 */
import { describe, expect, it } from "vitest";
import { stringifyForDiagnostics } from "./json-output.js";

describe("stringifyForDiagnostics", () => {
	it("preserves a shared reference, including at a different depth", () => {
		const shared = { id: 1 };
		expect(
			JSON.parse(stringifyForDiagnostics({ a: { s: shared }, b: shared })),
		).toEqual({ a: { s: { id: 1 } }, b: { id: 1 } });
	});

	it("still collapses a true cycle to [Circular]", () => {
		const cyclic: Record<string, unknown> = { name: "c" };
		cyclic.self = cyclic;
		expect(JSON.parse(stringifyForDiagnostics(cyclic))).toEqual({
			name: "c",
			self: "[Circular]",
		});
	});
});
