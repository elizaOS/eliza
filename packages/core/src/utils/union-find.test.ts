/**
 * Unit tests for `UnionFind<T>` disjoint-set.
 *
 * Covers: construction, add, has, find, union, groups, componentOf,
 * connected, size, clear.
 */
import { describe, expect, it } from "vitest";
import { UnionFind } from "./union-find";

describe("UnionFind", () => {
  it("constructs empty by default", () => {
    const uf = new UnionFind<string>();
    expect(uf.size).toBe(0);
    expect(uf.has("a")).toBe(false);
  });

  it("constructs from initial iterable", () => {
    const uf = new UnionFind(["a", "b", "c"]);
    expect(uf.size).toBe(3);
    expect(uf.has("b")).toBe(true);
  });

  it("find returns itself for singleton", () => {
    const uf = new UnionFind(["x"]);
    expect(uf.find("x")).toBe("x");
  });

  it("union merges two components", () => {
    const uf = new UnionFind(["a", "b"]);
    uf.union("a", "b");
    expect(uf.find("a")).toBe(uf.find("b"));
    expect(uf.connected("a", "b")).toBe(true);
    expect(uf.connected("a", "c")).toBe(false);
  });

  it("groups clusters by root", () => {
    const uf = new UnionFind(["a", "b", "c", "d"]);
    uf.union("a", "b");
    uf.union("c", "d");
    expect(uf.groups().size).toBe(2);
  });

  it("componentOf returns members containing value", () => {
    const uf = new UnionFind(["a", "b", "c"]);
    uf.union("a", "b");
    const members = uf.componentOf("a");
    expect(members).toEqual(expect.arrayContaining(["a", "b"]));
    expect(members).not.toContain("c");
  });

  it("size tracks registered nodes after clear", () => {
    const uf = new UnionFind(["a", "b"]);
    uf.clear();
    expect(uf.size).toBe(0);
    expect(uf.has("a")).toBe(false);
  });

  it("add is idempotent", () => {
    const uf = new UnionFind<string>();
    uf.add("x");
    uf.add("x");
    expect(uf.size).toBe(1);
  });
});
