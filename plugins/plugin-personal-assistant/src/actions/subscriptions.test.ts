/**
 * Deterministic unit tests for subscriptions action helper functions.
 * Validates planner boolean normalization against booleans, truthy/falsy strings, and invalid inputs.
 */
import { describe, expect, it } from "vitest";
import { normalizePlannerBoolean } from "./subscriptions.ts";

describe("normalizePlannerBoolean", () => {
  it("passes boolean literals through unchanged", () => {
    expect(normalizePlannerBoolean(true)).toBe(true);
    expect(normalizePlannerBoolean(false)).toBe(false);
  });

  it("normalizes truthy strings into boolean true", () => {
    for (const val of [
      "true",
      "TRUE",
      "yes",
      "YES",
      "1",
      "on",
      "ON",
      "enable",
      "enabled",
      " ENABLED ",
    ]) {
      expect(normalizePlannerBoolean(val)).toBe(true);
    }
  });

  it("normalizes falsy strings into boolean false", () => {
    for (const val of [
      "false",
      "FALSE",
      "no",
      "NO",
      "0",
      "off",
      "OFF",
      "disable",
      "disabled",
      " DISABLED ",
    ]) {
      expect(normalizePlannerBoolean(val)).toBe(false);
    }
  });

  it("returns null for non-boolean, non-recognized inputs", () => {
    expect(normalizePlannerBoolean("maybe")).toBeNull();
    expect(normalizePlannerBoolean("")).toBeNull();
    expect(normalizePlannerBoolean(null)).toBeNull();
    expect(normalizePlannerBoolean(undefined)).toBeNull();
    expect(normalizePlannerBoolean({})).toBeNull();
    expect(normalizePlannerBoolean(42)).toBeNull();
  });
});
