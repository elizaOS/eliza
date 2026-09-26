/**
 * Exercises diagnostic JSON serialization. Hostile/cyclic values must never
 * mask the event being reported, and a shared non-cyclic reference (a DAG —
 * the same object or array reachable from two keys) must be preserved instead
 * of being collapsed to "[Circular]" (#31004).
 */
import { describe, expect, it } from "vitest";
import { stringifyForDiagnostics } from "./json-output.js";

describe("stringifyForDiagnostics", () => {
	it("preserves an object shared by two keys instead of marking it [Circular]", () => {
		const shared = { id: 1 };
		expect(
			JSON.parse(stringifyForDiagnostics({ a: shared, b: shared })),
		).toEqual({
			a: { id: 1 },
			b: { id: 1 },
		});
	});

	it("preserves an array shared by two keys", () => {
		const shared = [1, 2, 3];
		expect(
			JSON.parse(stringifyForDiagnostics({ x: shared, y: shared })),
		).toEqual({
			x: [1, 2, 3],
			y: [1, 2, 3],
		});
	});

	it("preserves a shared reference that reappears at a different depth", () => {
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

	it("passes bare strings through and renders bigint losslessly", () => {
		expect(stringifyForDiagnostics("hello")).toBe("hello");
		expect(stringifyForDiagnostics({ n: 5n })).toContain('"5n"');
	});
});
