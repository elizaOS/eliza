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

	it("clears elements and resets structure", () => {
		const uf = new UnionFind(["x", "y", "z"]);
		expect(uf.size).toBe(3);

		uf.clear();
		expect(uf.size).toBe(0);
		expect(uf.has("x")).toBe(false);
		expect(uf.groups()).toEqual(new Map());
	});
});
