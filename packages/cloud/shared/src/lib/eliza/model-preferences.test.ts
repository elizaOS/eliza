/**
 * Coverage for model-preferences.
 */
import { describe, expect, it } from "vitest";
import { mergeModelPreferences, sanitizeModelPreferences } from "./model-preferences.js";

describe("model-preferences", () => {
  it("sanitizes valid", () => {
    expect(sanitizeModelPreferences({ nanoModel: " gpt-4 " })).toEqual({ nanoModel: "gpt-4" });
    expect(sanitizeModelPreferences({ nanoModel: "   " })).toBeUndefined();
    expect(sanitizeModelPreferences(null)).toBeUndefined();
    expect(sanitizeModelPreferences([])).toBeUndefined();
    expect(sanitizeModelPreferences({ unknown: "x" })).toBeUndefined();
  });
  it("merges preferences", () => {
    expect(mergeModelPreferences({ nanoModel: "a" }, { smallModel: "b" })).toEqual({
      nanoModel: "a",
      smallModel: "b",
    });
    expect(mergeModelPreferences(undefined, { nanoModel: "x" })).toEqual({ nanoModel: "x" });
    expect(mergeModelPreferences(undefined)).toBeUndefined();
  });
});
