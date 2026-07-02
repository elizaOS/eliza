// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultLayout,
  emptyLayout,
  LAUNCHER_PAGE_SIZE,
  LAUNCHER_STORAGE_KEY,
  type LauncherLayout,
  moveIcon,
  placedIds,
  readLauncherLayout,
  reconcileLayout,
  writeLauncherLayout,
} from "./launcher-layout.js";

describe("launcher-layout reconcile", () => {
  it("packs new available ids into pages of the given size", () => {
    const out = reconcileLayout(emptyLayout(), ["a", "b", "c"], 2);
    expect(out.pages).toEqual([["a", "b"], ["c"]]);
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
    const layout = { pages: [["a", "x", "b"]] };
    const out = reconcileLayout(layout, ["a", "b"], 4);
    expect(placedIds(out)).toEqual(new Set(["a", "b"]));
  });

  it("preserves a manual order and appends new ids at the end", () => {
    const layout = { pages: [["b", "a"]], manual: true };
    const out = reconcileLayout(layout, ["a", "b", "c"], 4);
    expect(out.pages[0]).toEqual(["b", "a", "c"]);
  });

  it("follows the incoming catalog order until manually arranged", () => {
    const layout = { pages: [["b", "a"]] };
    const out = reconcileLayout(layout, ["a", "b", "c"], 4);
    expect(out.pages[0]).toEqual(["a", "b", "c"]);
  });

  it("places every available view on a page (no dock reservation)", () => {
    const layout = { pages: [["a", "b"]] };
    const out = reconcileLayout(layout, ["a", "b", "c"], 4);
    expect(out.pages.flat()).toEqual(["a", "b", "c"]);
  });

  it("repacks pages so removals leave no holes", () => {
    const layout = {
      pages: [
        ["a", "b"],
        ["c", "d"],
      ],
    };
    const out = reconcileLayout(layout, ["a", "c", "d"], 2);
    expect(out.pages).toEqual([["a", "c"], ["d"]]);
  });
});

describe("launcher-layout moveIcon", () => {
  it("moves an icon to a new page/index without duplicating it", () => {
    const layout = { pages: [["a", "b", "c"]] };
    const out = moveIcon(layout, "a", 0, 2, 4);
    expect(out.pages.flat()).toEqual(["b", "c", "a"]);
    expect(out.pages.flat().filter((id) => id === "a")).toHaveLength(1);
  });

  it("marks the layout manual so the drag order is preserved", () => {
    const layout: LauncherLayout = {
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
    const layout = { pages: [["a", "b"]] };
    const out = moveIcon(layout, "a", 0, 99, 4);
    expect(out.pages.flat()).toEqual(["b", "a"]);
  });
});

describe("launcher-layout persistence", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips through localStorage", () => {
    const layout = { pages: [["b", "c"]] };
    writeLauncherLayout(layout);
    expect(readLauncherLayout()).toEqual(layout);
  });

  it("falls back to the first-run default on malformed storage", () => {
    window.localStorage.setItem(LAUNCHER_STORAGE_KEY, "{not json");
    expect(readLauncherLayout()).toEqual(defaultLayout());
  });

  it("first-run default is an empty page set (reconcile fills it)", () => {
    expect(readLauncherLayout()).toEqual(defaultLayout());
    expect(defaultLayout().pages).toEqual([]);
  });

  it("migrates a pre-rename 'springboard' layout forward (#9951)", () => {
    const legacy = {
      pages: [["b", "c"], ["d"]],
      manual: true,
    };
    window.localStorage.setItem(
      "elizaos.views.springboard",
      JSON.stringify(legacy),
    );

    // First read migrates: the saved page order / manual flag survive.
    expect(readLauncherLayout()).toEqual(legacy);
    // …and the layout is now persisted under the new key, old key cleared.
    expect(window.localStorage.getItem("elizaos.views.launcher")).toBe(
      JSON.stringify(legacy),
    );
    expect(window.localStorage.getItem("elizaos.views.springboard")).toBeNull();
  });

  it("drops a legacy 'favorites' field when parsing an old payload", () => {
    // Pre-removal payloads carried a `favorites` array; parsing keeps only
    // pages/manual so those docked ids flow back onto the grid via reconcile.
    window.localStorage.setItem(
      LAUNCHER_STORAGE_KEY,
      JSON.stringify({
        favorites: ["chat"],
        pages: [["b", "a"]],
        manual: true,
      }),
    );
    const layout = readLauncherLayout();
    expect(layout).toEqual({ pages: [["b", "a"]], manual: true });
    const out = reconcileLayout(layout, ["chat", "a", "b"], 4);
    expect(out.pages.flat()).toEqual(["b", "a", "chat"]);
  });
});
