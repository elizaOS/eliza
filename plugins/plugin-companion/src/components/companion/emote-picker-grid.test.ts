// Contract test: the EmotePicker grid is derived from the runtime emote catalog
// (emotes/catalog.ts), so every clickable picker id is one the agent server's
// POST /api/emote accepts (validated against EMOTE_BY_ID in
// packages/agent/src/api/misc-routes.ts). Previously EmotePicker shipped a
// hardcoded ALL_EMOTES grid where 17 of 29 ids were NOT in the catalog (clicking
// them returned 400 "Unknown emote") and 28 catalog emotes were missing. This
// test locks the reconciled state so the two cannot drift apart again.

import { describe, expect, it } from "vitest";
import { EMOTE_BY_ID, EMOTE_CATALOG } from "../../emotes/catalog";
import {
  buildCategoryList,
  buildEmoteGrid,
  categoryLabel,
} from "./emote-picker-grid";

const grid = buildEmoteGrid(EMOTE_CATALOG);

describe("EmotePicker grid ↔ runtime catalog contract", () => {
  it("renders one button per catalog emote (no omissions)", () => {
    expect(grid.length).toBe(EMOTE_CATALOG.length);
    expect(grid.length).toBeGreaterThan(28); // the full catalog, not the old 29-hardcoded subset
    const gridIds = grid.map((e) => e.id).sort();
    const catalogIds = EMOTE_CATALOG.map((e) => e.id).sort();
    expect(gridIds).toEqual(catalogIds);
  });

  it("every clickable picker id is accepted by the server (resolves in EMOTE_BY_ID)", () => {
    const rejected = grid
      .filter((e) => !EMOTE_BY_ID.has(e.id))
      .map((e) => e.id);
    expect(
      rejected,
      "these picker ids would 400 'Unknown emote' at POST /api/emote",
    ).toEqual([]);
  });

  it("has no duplicate ids and every item carries an icon + name", () => {
    expect(new Set(grid.map((e) => e.id)).size).toBe(grid.length);
    for (const item of grid) {
      const def = EMOTE_BY_ID.get(item.id);
      expect(
        def,
        `picker id "${item.id}" must resolve in catalog`,
      ).toBeDefined();
      expect(item.name).toBe(def?.name);
      // a Lucide component (forwardRef object or function)
      expect(item.icon == null).toBe(false);
      expect(["function", "object"]).toContain(typeof item.icon);
      expect(item.category).toBe(def?.category);
    }
  });

  it("category tabs cover exactly the categories present in the grid", () => {
    const cats = buildCategoryList(grid);
    const present = new Set(grid.map((e) => e.category));
    // Every tab maps to a real category...
    for (const cat of cats) expect(present.has(cat)).toBe(true);
    // ...and every category present in the grid has a tab (nothing unreachable).
    for (const cat of present) expect(cats).toContain(cat);
    expect(cats.length).toBe(present.size);
  });

  it("labels are human-readable title case", () => {
    expect(categoryLabel("dance")).toBe("Dance");
    expect(categoryLabel("rude-gesture")).toBe("Rude Gesture");
  });
});
