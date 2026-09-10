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
});
