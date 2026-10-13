import { expect, test } from "vitest";
import { UnionFind } from "../src/utils/union-find";

test("nullish roots preserve connected components", () => {
	for (const root of [null, undefined]) {
		const uf = new UnionFind<string | null | undefined>();
		uf.union(root, "a");
		uf.union("a", "b");
		expect(uf.connected(root, "b")).toBe(true);
		expect(uf.find("b")).toBe(root);
		expect(uf.componentOf("a")).toEqual([root, "a", "b"]);
		expect(uf.groups()).toEqual(new Map([[root, [root, "a", "b"]]]));
	}
	const uf = new UnionFind<string>();
	uf.union("a", "b");
	expect(uf.connected("a", "b")).toBe(true);
	expect(uf.connected("a", "unknown")).toBe(false);
});
