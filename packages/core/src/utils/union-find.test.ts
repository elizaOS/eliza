/**
 * Unit tests for UnionFind in packages/core/src/utils/union-find.ts.
 */

import { describe, expect, it } from "vitest";
import { UnionFind } from "./union-find";

describe("UnionFind", () => {
	it("initializes with elements and supports add/has/size", () => {
		const uf = new UnionFind(["a", "b", "c"]);
		expect(uf.size).toBe(3);
		expect(uf.has("a")).toBe(true);
		expect(uf.has("b")).toBe(true);
		expect(uf.has("c")).toBe(true);
		expect(uf.has("d")).toBe(false);

		uf.add("d");
		expect(uf.has("d")).toBe(true);
		expect(uf.size).toBe(4);
	});

	it("merges disjoint sets and reports connectivity accurately", () => {
		const uf = new UnionFind<string>();
		expect(uf.connected("a", "b")).toBe(false);
		expect(uf.size).toBe(0);

		uf.union("a", "b");
		expect(uf.connected("a", "b")).toBe(true);
		expect(uf.connected("a", "c")).toBe(false);

		uf.union("b", "c");
		expect(uf.connected("a", "c")).toBe(true);

		uf.union("d", "e");
		expect(uf.connected("d", "e")).toBe(true);
		expect(uf.connected("a", "d")).toBe(false);

		uf.union("c", "d");
		expect(uf.connected("a", "e")).toBe(true);
	});

	it("computes groups and component members", () => {
		const uf = new UnionFind<string>();
		uf.union("entity1", "entity2");
		uf.union("entity2", "entity3");
		uf.union("other1", "other2");

		const comp1 = uf.componentOf("entity1");
		expect(comp1.sort()).toEqual(["entity1", "entity2", "entity3"].sort());

		const comp2 = uf.componentOf("other1");
		expect(comp2.sort()).toEqual(["other1", "other2"].sort());

		const standalone = uf.componentOf("unregistered");
		expect(standalone).toEqual(["unregistered"]);

		const groups = uf.groups();
		expect(groups.size).toBe(2);
	});

	it("resolves a chain-shaped component far deeper than the JS call stack", () => {
		// `union()` has no union-by-rank heuristic, so edges arriving in this
		// order re-root one level at a time and build a parent chain as deep as
		// the component is large. This is the shape
		// `RelationshipsService.buildIdentityUnionFind` produces for a path of
		// confirmed identity links. A recursive `find()` needs one stack frame
		// per link and throws RangeError here (measured threshold ~10.3k links
		// on an empty stack); this must resolve instead.
		const links = 50_000;
		const uf = new UnionFind<string>();
		for (let index = 0; index < links; index += 1) {
			uf.union(`e${index + 1}`, `e${index}`);
		}

		const root = uf.find("e0");
		expect(root).toBe(`e${links}`);
		expect(uf.connected("e0", `e${links}`)).toBe(true);
		expect(uf.size).toBe(links + 1);
	});

	it("compresses every node on the path to the root", () => {
		const uf = new UnionFind<string>();
		uf.union("b", "a");
		uf.union("c", "b");
		uf.union("d", "c");
		// Chain before the lookup: a -> b -> c -> d.
		expect(uf.find("d")).toBe("d");

		const root = uf.find("a");
		expect(root).toBe("d");
		// Every node the walk passed through now points straight at the root,
		// so a second lookup is a single hop.
		for (const node of ["a", "b", "c"]) {
			expect(uf.find(node)).toBe("d");
		}
		expect(uf.componentOf("a").sort()).toEqual(["a", "b", "c", "d"]);
	});

	it("clears elements and resets structure", () => {
		const uf = new UnionFind(["x", "y", "z"]);
		expect(uf.size).toBe(3);

		uf.clear();
		expect(uf.size).toBe(0);
		expect(uf.has("x")).toBe(false);
		expect(uf.groups()).toEqual(new Map());
	});
});
