/** Verifies log-viewer timestamp formatting rejects malformed values. */
import { describe, expect, it, vi } from "vitest";
import { formatTimestamp } from "./log-viewer-format";

describe("formatTimestamp", () => {
  it("returns empty for missing and non-finite timestamps", () => {
    expect(formatTimestamp(undefined)).toBe("");
    expect(formatTimestamp(null)).toBe("");
    expect(formatTimestamp("")).toBe("");
    expect(formatTimestamp("not-a-date")).toBe("");
    expect(formatTimestamp(Number.NaN)).toBe("");
    expect(formatTimestamp(new Date(Number.NaN))).toBe("");
  });

  it("formats finite timestamps with toLocaleTimeString", () => {
    const spy = vi
      .spyOn(Date.prototype, "toLocaleTimeString")
      .mockReturnValue("12:34:56 PM");
    try {
      expect(formatTimestamp("2026-01-15T12:34:56.000Z")).toBe("12:34:56 PM");
      expect(formatTimestamp(1_768_478_400_000)).toBe("12:34:56 PM");
      expect(formatTimestamp(new Date(1_768_478_400_000))).toBe("12:34:56 PM");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
