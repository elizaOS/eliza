/**
 * Pins the reference handling of `stringifyForDiagnostics`, the serializer
 * behind trajectory and evaluator diagnostics: a shared object must render
 * in full at every site, and only a reference back to an open ancestor may
 * collapse to "[Circular]". Deterministic; no mocks.
 */

import { describe, expect, it } from "vitest";
import { stringifyForDiagnostics } from "./json-output.js";

describe("stringifyForDiagnostics reference handling", () => {
	it("renders a shared (non-cyclic) reference in full at every site", () => {
		const shared = { id: 1, tag: "t" };
		const out = JSON.parse(
			stringifyForDiagnostics({ a: shared, b: shared, list: [shared, shared] }),
		);
		expect(out).toEqual({
			a: { id: 1, tag: "t" },
			b: { id: 1, tag: "t" },
			list: [
				{ id: 1, tag: "t" },
				{ id: 1, tag: "t" },
			],
		});
	});

	it("still collapses a true cycle to [Circular] and serializes its siblings", () => {
		const root: Record<string, unknown> = { name: "root" };
		root.self = root;
		root.child = { parent: root, tag: "t" };
		expect(JSON.parse(stringifyForDiagnostics(root))).toEqual({
			name: "root",
			self: "[Circular]",
			child: { parent: "[Circular]", tag: "t" },
		});
	});

	it("bounds a diamond-shaped shared graph instead of expanding it exponentially", () => {
		// 21 distinct objects, each holding the same next level under two keys:
		// 2^20 paths. The serializer must stop at the node ceiling (50 000
		// objects) and keep the event readable instead of overflowing.
		let level: Record<string, unknown> = { leaf: true };
		for (let i = 0; i < 20; i++) level = { l: level, r: level };
		const started = performance.now();
		const text = stringifyForDiagnostics({ event: "probe", payload: level });
		const elapsedMs = performance.now() - started;
		expect(text).toContain('"event": "probe"');
		expect(text).toContain('"[Truncated]"');
		let objects = 0;
		const walk = (value: unknown): void => {
			if (value && typeof value === "object") {
				objects += 1;
				for (const item of Object.values(value)) walk(item);
			}
		};
		walk(JSON.parse(text));
		expect(objects).toBeLessThanOrEqual(50_000);
		expect(elapsedMs).toBeLessThan(5_000);
	});
});
