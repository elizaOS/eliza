/** Verifies formatRelative falls back gracefully on invalid/non-finite dates. */
import { describe, expect, it } from "vitest";
import { formatRelative } from "./sandbox-status";

describe("formatRelative", () => {
  it("returns Never for null", () => {
    expect(formatRelative(null)).toBe("Never");
  });

  it("formats a valid recent date", () => {
    expect(formatRelative(new Date())).toBe("Just now");
  });

  it("returns Never for an unparseable date string", () => {
    expect(formatRelative("not-a-date")).toBe("Never");
  });

  it("returns Never for an already-invalid Date object", () => {
    expect(formatRelative(new Date(Number.NaN))).toBe("Never");
  });
});
