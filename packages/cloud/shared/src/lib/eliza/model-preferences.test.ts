/**
 * Pins model-preference sanitization and merge order. These values select
 * which model a hosted agent calls, and they arrive from stored JSON, so the
 * allowlist must reject unknown and inherited keys and the merge must be
 * last-wins per key rather than whole-object replacement. Pure module, no
 * harness.
 */

import { describe, expect, test } from "bun:test";
import {
  MODEL_PREFERENCE_KEYS,
  type ModelPreferences,
  mergeModelPreferences,
  normalizeModelPreferences,
  sanitizeModelPreferences,
} from "./model-preferences";

describe("MODEL_PREFERENCE_KEYS", () => {
  test("is non-empty and free of duplicates", () => {
    expect(MODEL_PREFERENCE_KEYS.length).toBeGreaterThan(0);
    expect(new Set(MODEL_PREFERENCE_KEYS).size).toBe(MODEL_PREFERENCE_KEYS.length);
  });

  test("every key is a camelCase name ending in Model", () => {
    for (const key of MODEL_PREFERENCE_KEYS) {
      expect(key).toMatch(/^[a-z][A-Za-z]*Model$/);
    }
  });
});

describe("sanitizeModelPreferences — rejected input", () => {
  test("rejects non-objects", () => {
    for (const value of [null, undefined, 0, 1, "", "x", true, false]) {
      expect(sanitizeModelPreferences(value)).toBeUndefined();
    }
  });

  test("rejects arrays", () => {
    expect(sanitizeModelPreferences([])).toBeUndefined();
    expect(sanitizeModelPreferences([{ smallModel: "a" }])).toBeUndefined();
  });

  test("rejects an array even when it carries an allowlisted property", () => {
    // A plain array is rejected by the key allowlist anyway, so this is the
    // case that actually isolates the Array.isArray guard: without it, the
    // property below would be read straight off the array and returned as a
    // valid preference set.
    const arrayWithProperty = Object.assign([], { smallModel: "sneaky" });
    expect(sanitizeModelPreferences(arrayWithProperty)).toBeUndefined();
  });

  test("returns undefined rather than an empty object", () => {
    expect(sanitizeModelPreferences({})).toBeUndefined();
    expect(sanitizeModelPreferences({ unknownKey: "value" })).toBeUndefined();
  });

  test("drops blank and whitespace-only values", () => {
    expect(sanitizeModelPreferences({ smallModel: "", largeModel: "   \t\n" })).toBeUndefined();
  });

  test("drops non-string values", () => {
    expect(
      sanitizeModelPreferences({
        smallModel: 42,
        largeModel: null,
        megaModel: {},
        nanoModel: ["a"],
        plannerModel: true,
      }),
    ).toBeUndefined();
  });
});

describe("sanitizeModelPreferences — accepted input", () => {
  test("keeps every declared key", () => {
    const input = Object.fromEntries(MODEL_PREFERENCE_KEYS.map((key) => [key, `model-for-${key}`]));
    const result = sanitizeModelPreferences(input);
    expect(Object.keys(result ?? {}).sort()).toEqual([...MODEL_PREFERENCE_KEYS].sort());
  });

  test("trims surrounding whitespace", () => {
    expect(sanitizeModelPreferences({ smallModel: "  gpt-x  " })).toEqual({
      smallModel: "gpt-x",
    });
  });

  test("strips keys outside the allowlist", () => {
    const result = sanitizeModelPreferences({
      smallModel: "keep",
      __proto__: "evil",
      constructor: "evil",
      toString: "evil",
      arbitrary: "evil",
    });
    expect(result).toEqual({ smallModel: "keep" });
  });

  test("keeps the valid entries alongside invalid ones", () => {
    expect(
      sanitizeModelPreferences({
        smallModel: "keep",
        largeModel: "",
        megaModel: 7,
      }),
    ).toEqual({ smallModel: "keep" });
  });

  test("returns a fresh object rather than the input", () => {
    const input = { smallModel: "a" };
    expect(sanitizeModelPreferences(input)).not.toBe(input);
  });

  test("does not mutate its input", () => {
    const input = { smallModel: "  a  ", junk: "b" };
    const snapshot = { ...input };
    sanitizeModelPreferences(input);
    expect(input).toEqual(snapshot);
  });

  test("is idempotent", () => {
    const once = sanitizeModelPreferences({ smallModel: " a ", megaModel: "b" });
    expect(sanitizeModelPreferences(once)).toEqual(once as ModelPreferences);
  });
});

describe("mergeModelPreferences", () => {
  test("returns undefined when nothing contributes a value", () => {
    expect(mergeModelPreferences()).toBeUndefined();
    expect(mergeModelPreferences(undefined, undefined)).toBeUndefined();
    expect(mergeModelPreferences({}, {})).toBeUndefined();
  });

  test("skips undefined entries", () => {
    expect(mergeModelPreferences(undefined, { smallModel: "a" }, undefined)).toEqual({
      smallModel: "a",
    });
  });

  test("later sources win per key", () => {
    expect(mergeModelPreferences({ smallModel: "first" }, { smallModel: "second" })).toEqual({
      smallModel: "second",
    });
  });

  test("merges per key rather than replacing the whole object", () => {
    expect(
      mergeModelPreferences({ smallModel: "a", largeModel: "b" }, { largeModel: "c" }),
    ).toEqual({ smallModel: "a", largeModel: "c" });
  });

  test("a blank value does not erase an earlier one", () => {
    expect(mergeModelPreferences({ smallModel: "keep" }, { smallModel: "   " })).toEqual({
      smallModel: "keep",
    });
  });

  test("trims as it merges", () => {
    expect(mergeModelPreferences({ smallModel: "  a  " })).toEqual({
      smallModel: "a",
    });
  });

  test("ignores keys outside the allowlist", () => {
    expect(
      mergeModelPreferences({
        smallModel: "keep",
        rogueModel: "drop",
      } as ModelPreferences),
    ).toEqual({ smallModel: "keep" });
  });

  test("does not mutate its sources", () => {
    const first = { smallModel: "a" };
    const second = { largeModel: "b" };
    const snapshots = [{ ...first }, { ...second }];
    mergeModelPreferences(first, second);
    expect([first, second]).toEqual(snapshots);
  });

  test("a single source round-trips through sanitize", () => {
    const input = { smallModel: " a ", megaModel: "b" };
    expect(mergeModelPreferences(input)).toEqual(
      sanitizeModelPreferences(input) as ModelPreferences,
    );
  });
});

describe("normalizeModelPreferences", () => {
  test("agrees with sanitizeModelPreferences", () => {
    for (const input of [
      undefined,
      {},
      { smallModel: "a" },
      { smallModel: "  a  ", largeModel: "" },
    ] as Array<ModelPreferences | undefined>) {
      expect(normalizeModelPreferences(input)).toEqual(
        sanitizeModelPreferences(input) as ModelPreferences,
      );
    }
  });

  test("is idempotent", () => {
    const once = normalizeModelPreferences({ smallModel: " a " });
    expect(normalizeModelPreferences(once)).toEqual(once as ModelPreferences);
  });
});
