/**
 * Coverage for date-range-params.
 */
import { describe, expect, it } from "vitest";

import { parseDateRangeParams } from "./date-range-params.js";

describe("parseDateRangeParams", () => {
  it("returns success with no params", () => {
    const r = parseDateRangeParams(new URLSearchParams());
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.startDate).toBeUndefined();
      expect(r.endDate).toBeUndefined();
    }
  });

  it("parses valid range", () => {
    const r = parseDateRangeParams(
      new URLSearchParams("start_date=2024-01-01&end_date=2024-01-10"),
    );
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.startDate?.toISOString().slice(0, 10)).toBe("2024-01-01");
      expect(r.endDate?.toISOString().slice(0, 10)).toBe("2024-01-10");
    }
  });

  it("rejects invalid start", () => {
    const r = parseDateRangeParams(new URLSearchParams("start_date=invalid"));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain("Invalid start_date");
  });

  it("rejects invalid end", () => {
    const r = parseDateRangeParams(new URLSearchParams("end_date=not-a-date"));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain("Invalid end_date");
  });

  it("rejects start after end", () => {
    const r = parseDateRangeParams(
      new URLSearchParams("start_date=2024-02-01&end_date=2024-01-01"),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain("must not be after");
  });

  it("rejects invalid ISO overflow", () => {
    const r = parseDateRangeParams(new URLSearchParams("start_date=2024-02-30"));
    expect(r.success).toBe(false);
  });

  it("handles single start only", () => {
    const r = parseDateRangeParams(new URLSearchParams("start_date=2024-03-15"));
    expect(r.success).toBe(true);
    if (r.success) expect(r.startDate?.toISOString().slice(0, 10)).toBe("2024-03-15");
  });
});
