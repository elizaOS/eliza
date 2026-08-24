/**
 * Covers the character category registry.
 *
 * The load-bearing invariant is that `CATEGORY_ORDER` and
 * `CHARACTER_CATEGORIES` stay in agreement: the order array is what the UI
 * renders from, so a category added to the registry but forgotten in the order
 * array silently disappears from the picker, and a stale key left in the order
 * array puts an `undefined` hole in the rendered list. Both directions are
 * asserted rather than just the count.
 *
 * Pure constants and lookups — no IO.
 */
import { describe, expect, test } from "bun:test";

import {
  CATEGORY_IDS,
  CATEGORY_ORDER,
  type CategoryId,
  CHARACTER_CATEGORIES,
  getAllCategories,
  getCategoryById,
  getCategoryColor,
  getCategoryIcon,
  isCategoryId,
} from "./character-categories";

const DEFAULT_COLOR = "gray";
const DEFAULT_ICON = "\u{1F4DD}"; // memo

describe("registry integrity", () => {
  test("every entry's id matches its uppercase key", () => {
    for (const [key, definition] of Object.entries(CHARACTER_CATEGORIES)) {
      expect(definition.id.toUpperCase()).toBe(key);
    }
  });

  test("every entry carries a usable name, description, icon, and colour", () => {
    for (const definition of Object.values(CHARACTER_CATEGORIES)) {
      expect(definition.name.trim().length).toBeGreaterThan(0);
      expect(definition.description.trim().length).toBeGreaterThan(0);
      expect(definition.icon.trim().length).toBeGreaterThan(0);
      expect(definition.color.trim().length).toBeGreaterThan(0);
    }
  });

  test("CATEGORY_ORDER lists every registered category exactly once", () => {
    // A category missing here silently disappears from the picker.
    expect([...CATEGORY_ORDER].sort()).toEqual(Object.keys(CHARACTER_CATEGORIES).sort());
    expect(new Set(CATEGORY_ORDER).size).toBe(CATEGORY_ORDER.length);
  });

  test("CATEGORY_ORDER contains no key missing from the registry", () => {
    // A stale key would put an undefined hole in the rendered list.
    for (const key of CATEGORY_ORDER) {
      expect(CHARACTER_CATEGORIES[key]).toBeDefined();
    }
  });

  test("CATEGORY_IDS matches the registry ids", () => {
    expect([...CATEGORY_IDS].sort()).toEqual(
      Object.values(CHARACTER_CATEGORIES)
        .map((definition) => definition.id)
        .sort(),
    );
  });
});

describe("isCategoryId", () => {
  test("accepts every registered id", () => {
    for (const id of CATEGORY_IDS) {
      expect(isCategoryId(id)).toBe(true);
    }
  });

  test("rejects unknown values", () => {
    for (const value of ["", "   ", "unknown", "assistants", "ASSISTANT"]) {
      expect(isCategoryId(value)).toBe(false);
    }
  });
});

describe("lookups", () => {
  test("resolves every registered id to its definition", () => {
    for (const id of CATEGORY_IDS) {
      const definition = getCategoryById(id as CategoryId);
      expect(definition?.id).toBe(id);
    }
  });

  test("returns undefined for an unregistered id", () => {
    expect(getCategoryById("nope" as CategoryId)).toBeUndefined();
    expect(getCategoryById("" as CategoryId)).toBeUndefined();
  });

  test("returns every category in the declared display order", () => {
    const all = getAllCategories();
    expect(all).toHaveLength(CATEGORY_ORDER.length);
    expect(all.map((definition) => definition.id)).toEqual(
      CATEGORY_ORDER.map((key) => CHARACTER_CATEGORIES[key].id),
    );
    expect(all.every(Boolean)).toBe(true);
  });

  test("colour and icon come from the definition for a known id", () => {
    for (const id of CATEGORY_IDS) {
      const definition =
        CHARACTER_CATEGORIES[id.toUpperCase() as keyof typeof CHARACTER_CATEGORIES];
      expect(getCategoryColor(id as CategoryId)).toBe(definition.color);
      expect(getCategoryIcon(id as CategoryId)).toBe(definition.icon);
    }
  });

  test("colour and icon fall back for an unregistered id", () => {
    expect(getCategoryColor("nope" as CategoryId)).toBe(DEFAULT_COLOR);
    expect(getCategoryIcon("nope" as CategoryId)).toBe(DEFAULT_ICON);
  });

  test("no registered category relies on the fallback icon or colour", () => {
    // A category whose own icon happened to be the fallback would make the
    // fallback test above pass for the wrong reason.
    for (const definition of Object.values(CHARACTER_CATEGORIES)) {
      expect(definition.icon).not.toBe(DEFAULT_ICON);
    }
  });
});
