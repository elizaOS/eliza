// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultLayout,
  emptyLayout,
  LAUNCHER_DOCK_LIMIT,
  LAUNCHER_PAGE_SIZE,
  LAUNCHER_STORAGE_KEY,
  type LauncherLayout,
  moveIcon,
  placedIds,
  readLauncherLayout,
  reconcileLayout,
  toggleFavorite,
  writeLauncherLayout,
} from "./launcher-layout.js";

describe("launcher-layout reconcile", () => {
  it("packs new available ids into pages of the given size", () => {
    const out = reconcileLayout(emptyLayout(), ["a", "b", "c"], 2);
    expect(out.pages).toEqual([["a", "b"], ["c"]]);
    expect(out.favorites).toEqual([]);
  });

  it("uses a 4×6 = 24-tile default page size", () => {
    expect(LAUNCHER_PAGE_SIZE).toBe(24);
  });

  it("splits views into pages of 24 by default (4 columns × 6 rows)", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `v${i}`);
    const out = reconcileLayout(emptyLayout(), ids);
    // 50 ids → 24 + 24 + 2 across three pages.
    expect(out.pages).toHaveLength(3);
    expect(out.pages[0]).toHaveLength(24);
    expect(out.pages[1]).toHaveLength(24);
    expect(out.pages[2]).toHaveLength(2);
  });

  it("keeps a single page when views fit within 24", () => {
    const ids = Array.from({ length: 24 }, (_, i) => `v${i}`);
    const out = reconcileLayout(emptyLayout(), ids);
    expect(out.pages).toHaveLength(1);
    expect(out.pages[0]).toHaveLength(24);
  });

  it("drops ids that are no longer available", () => {
    const layout = { favorites: ["x"], pages: [["a", "x", "b"]] };
    const out = reconcileLayout(layout, ["a", "b"], 4);
    expect(placedIds(out)).toEqual(new Set(["a", "b"]));
    expect(out.favorites).toEqual([]);
  });

  it("preserves a manual order and appends new ids at the end", () => {
    const layout = { favorites: [], pages: [["b", "a"]], manual: true };
    const out = reconcileLayout(layout, ["a", "b", "c"], 4);
    expect(out.pages[0]).toEqual(["b", "a", "c"]);
  });

  it("follows the incoming catalog order until manually arranged", () => {
    const layout = { favorites: [], pages: [["b", "a"]] };
    const out = reconcileLayout(layout, ["a", "b", "c"], 4);
    expect(out.pages[0]).toEqual(["a", "b", "c"]);
  });

  it("keeps favorites in the page grid", () => {
    const layout = { favorites: ["a"], pages: [["a", "b"]] };
    const out = reconcileLayout(layout, ["a", "b"], 4);
    expect(out.favorites).toEqual(["a"]);
    expect(out.pages.flat()).toEqual(["a", "b"]);
  });

  it("repacks pages so removals leave no holes", () => {
    const layout = {
      favorites: [],
      pages: [
        ["a", "b"],
        ["c", "d"],
      ],
    };
    const out = reconcileLayout(layout, ["a", "c", "d"], 2);
    expect(out.pages).toEqual([["a", "c"], ["d"]]);
  });
});

describe("launcher-layout favorites", () => {
  it("toggles an id into and out of favorites metadata", () => {
    const added = toggleFavorite(emptyLayout(), "a");
    expect(added.favorites).toEqual(["a"]);
    const removed = toggleFavorite(added, "a");
    expect(removed.favorites).toEqual([]);
  });

  it("evicts the oldest favorite when metadata reaches the shared pin cap", () => {
    let layout = emptyLayout();
    for (const id of ["a", "b", "c", "d", "e"]) {
      layout = toggleFavorite(layout, id);
    }
    expect(layout.favorites).toHaveLength(LAUNCHER_DOCK_LIMIT);
    expect(layout.favorites).toEqual(["b", "c", "d", "e"]);
  });
});

describe("launcher-layout moveIcon", () => {
  it("moves an icon to a new page/index without duplicating it", () => {
    const layout = { favorites: [], pages: [["a", "b", "c"]] };
    const out = moveIcon(layout, "a", 0, 2, 4);
    expect(out.pages.flat()).toEqual(["b", "c", "a"]);
    expect(out.pages.flat().filter((id) => id === "a")).toHaveLength(1);
  });

  it("preserves favorite metadata when moving a page tile", () => {
    const layout = { favorites: ["a"], pages: [["b"]] };
    const out = moveIcon(layout, "a", 0, 0, 4);
    expect(out.favorites).toEqual(["a"]);
    expect(out.pages[0]).toEqual(["a", "b"]);
  });

  it("marks the layout manual so the drag order is preserved", () => {
    const layout: LauncherLayout = {
      favorites: [],
      pages: [["a", "b", "c"]],
    };
    expect(layout.manual).toBeUndefined();
    const out = moveIcon(layout, "c", 0, 0, 4);
    expect(out.manual).toBe(true);
    // And reconcile now keeps that manual order instead of catalog order.
    const reconciled = reconcileLayout(out, ["a", "b", "c"], 4);
    expect(reconciled.pages[0]).toEqual(["c", "a", "b"]);
  });

  it("moves an icon across pages, repacking the flattened order", () => {
    // Two full pages of size 2; drag the last icon to the front of page 0.
    const layout = {
      favorites: [],
      pages: [
        ["a", "b"],
        ["c", "d"],
      ],
    };
    const out = moveIcon(layout, "d", 0, 0, 2);
    expect(out.pages.flat()).toEqual(["d", "a", "b", "c"]);
    expect(out.pages).toEqual([
      ["d", "a"],
      ["b", "c"],
    ]);
  });

  it("clamps a target index beyond the page length to the end", () => {
    const layout = { favorites: [], pages: [["a", "b"]] };
    const out = moveIcon(layout, "a", 0, 99, 4);
    expect(out.pages.flat()).toEqual(["b", "a"]);
  });
});

describe("launcher-layout persistence", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips through localStorage", () => {
    const layout = { favorites: ["a"], pages: [["b", "c"]] };
    writeLauncherLayout(layout);
    expect(readLauncherLayout()).toEqual(layout);
  });

  it("returns an empty layout on malformed storage", () => {
    window.localStorage.setItem(LAUNCHER_STORAGE_KEY, "{not json");
    expect(readLauncherLayout()).toEqual(emptyLayout());
  });

  it("migrates a pre-rename 'springboard' layout forward (#9951)", () => {
    const legacy = {
      favorites: ["a"],
      pages: [["b", "c"], ["d"]],
      manual: true,
    };
    window.localStorage.setItem(
      "elizaos.views.springboard",
      JSON.stringify(legacy),
    );

    // First read migrates: the saved page order / favorites / manual flag survive.
    expect(readLauncherLayout()).toEqual(legacy);
    // …and the layout is now persisted under the new key, old key cleared.
    expect(window.localStorage.getItem("elizaos.views.launcher")).toBe(
      JSON.stringify(legacy),
    );
    expect(window.localStorage.getItem("elizaos.views.springboard")).toBeNull();
  });
});

describe("launcher-layout without a favorites dock (#10789)", () => {
  beforeEach(() => window.localStorage.clear());

  it("seeds an empty layout on first run", () => {
    expect(readLauncherLayout()).toEqual(defaultLayout());
    expect(readLauncherLayout().favorites).toEqual([]);
    expect(readLauncherLayout().pages).toEqual([]);
  });

  it("first-run default seeds no favorites", () => {
    expect(defaultLayout().favorites).toEqual([]);
  });

  it("flows every available view onto pages (no favorites row reserved)", () => {
    // With no favorites row, every available id lands on a page tile.
    const out = reconcileLayout(defaultLayout(), [
      "settings",
      "activity",
      "files",
      "notes",
    ]);
    expect(out.favorites).toEqual([]);
    expect(out.pages.flat()).toEqual([
      "settings",
      "activity",
      "files",
      "notes",
    ]);
  });
});
