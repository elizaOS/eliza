/** Diagnostic serialization keeps shared (non-cyclic) references intact and marks only true cycles. */
import { describe, expect, it } from "vitest";
import { stringifyForDiagnostics } from "./json-output";

describe("stringifyForDiagnostics shared references", () => {
	it("expands a sibling alias in full", () => {
		const shared = { id: 1 };
		expect(
			JSON.parse(stringifyForDiagnostics({ a: shared, b: shared })),
		).toEqual({ a: { id: 1 }, b: { id: 1 } });
	});

	it("expands repeated array entries and nested fan-in", () => {
		const leaf = { v: "x" };
		const branch = { leaf };
		const parsed = JSON.parse(
			stringifyForDiagnostics({
				list: [leaf, leaf],
				left: branch,
				right: { branch },
			}),
		);
		expect(parsed).toEqual({
			list: [{ v: "x" }, { v: "x" }],
			left: { leaf: { v: "x" } },
			right: { branch: { leaf: { v: "x" } } },
		});
	});

	it("marks a reference back to an ancestor as circular", () => {
		const node: Record<string, unknown> = { name: "root" };
		node.self = node;
		node.child = { parent: node, sibling: { name: "s" } };
		expect(JSON.parse(stringifyForDiagnostics(node))).toEqual({
			name: "root",
			self: "[Circular]",
			child: { parent: "[Circular]", sibling: { name: "s" } },
		});
	});

	it("expands an alias again after a closed cycle", () => {
		const shared: Record<string, unknown> = { id: 2 };
		shared.loop = shared;
		expect(
			JSON.parse(stringifyForDiagnostics({ a: shared, b: shared })),
		).toEqual({
			a: { id: 2, loop: "[Circular]" },
			b: { id: 2, loop: "[Circular]" },
		});
	});

	it("renders bigint values", () => {
		expect(JSON.parse(stringifyForDiagnostics({ n: 10n }))).toEqual({
			n: "10n",
		});
	});
});
