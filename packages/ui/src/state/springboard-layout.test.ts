// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  emptyLayout,
  moveIcon,
  placedIds,
  readSpringboardLayout,
  reconcileLayout,
  SPRINGBOARD_DOCK_LIMIT,
  SPRINGBOARD_STORAGE_KEY,
  toggleFavorite,
  writeSpringboardLayout,
} from "./springboard-layout.js";

describe("springboard-layout reconcile", () => {
  it("packs new available ids into pages of the given size", () => {
    const out = reconcileLayout(emptyLayout(), ["a", "b", "c"], 2);
    expect(out.pages).toEqual([["a", "b"], ["c"]]);
    expect(out.favorites).toEqual([]);
  });

  it("drops ids that are no longer available", () => {
    const layout = { favorites: ["x"], pages: [["a", "x", "b"]] };
    const out = reconcileLayout(layout, ["a", "b"], 4);
    expect(placedIds(out)).toEqual(new Set(["a", "b"]));
    expect(out.favorites).toEqual([]);
  });

  it("preserves existing order and appends new ids at the end", () => {
    const layout = { favorites: [], pages: [["b", "a"]] };
    const out = reconcileLayout(layout, ["a", "b", "c"], 4);
    expect(out.pages[0]).toEqual(["b", "a", "c"]);
  });

  it("keeps favorites out of the page grid", () => {
    const layout = { favorites: ["a"], pages: [["a", "b"]] };
    const out = reconcileLayout(layout, ["a", "b"], 4);
    expect(out.favorites).toEqual(["a"]);
    expect(out.pages.flat()).toEqual(["b"]);
  });

  it("repacks pages so removals leave no holes", () => {
    const layout = { favorites: [], pages: [["a", "b"], ["c", "d"]] };
    const out = reconcileLayout(layout, ["a", "c", "d"], 2);
    expect(out.pages).toEqual([["a", "c"], ["d"]]);
  });
});

describe("springboard-layout favorites", () => {
  it("toggles an id into and out of the dock", () => {
    const added = toggleFavorite(emptyLayout(), "a");
    expect(added.favorites).toEqual(["a"]);
    const removed = toggleFavorite(added, "a");
    expect(removed.favorites).toEqual([]);
  });

  it("evicts the oldest favorite when the dock is full", () => {
    let layout = emptyLayout();
    for (const id of ["a", "b", "c", "d", "e"]) {
      layout = toggleFavorite(layout, id);
    }
    expect(layout.favorites).toHaveLength(SPRINGBOARD_DOCK_LIMIT);
    expect(layout.favorites).toEqual(["b", "c", "d", "e"]);
  });
});

describe("springboard-layout moveIcon", () => {
  it("moves an icon to a new page/index without duplicating it", () => {
    const layout = { favorites: [], pages: [["a", "b", "c"]] };
    const out = moveIcon(layout, "a", 0, 2, 4);
    expect(out.pages.flat()).toEqual(["b", "c", "a"]);
    expect(out.pages.flat().filter((id) => id === "a")).toHaveLength(1);
  });

  it("removes the icon from the dock when moved to a page", () => {
    const layout = { favorites: ["a"], pages: [["b"]] };
    const out = moveIcon(layout, "a", 0, 0, 4);
    expect(out.favorites).toEqual([]);
    expect(out.pages[0]).toEqual(["a", "b"]);
  });
});

describe("springboard-layout persistence", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips through localStorage", () => {
    const layout = { favorites: ["a"], pages: [["b", "c"]] };
    writeSpringboardLayout(layout);
    expect(readSpringboardLayout()).toEqual(layout);
  });

  it("returns an empty layout on malformed storage", () => {
    window.localStorage.setItem(SPRINGBOARD_STORAGE_KEY, "{not json");
    expect(readSpringboardLayout()).toEqual(emptyLayout());
  });
});
