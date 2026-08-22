/** Deterministically exercises the TASKS history pagination contract: strict
 * limit parsing with REPORTED (never silent) clamps, canonical offsets, and
 * the explicit {page, total, hasMore} window (prompt-integrity: caller-driven
 * pagination with a continuation contract). */
import { describe, expect, it } from "vitest";
import {
  MAX_HISTORY_LIMIT,
  paginateHistory,
  parseHistoryLimit,
  parseHistoryOffset,
} from "../tasks-history-limit";

describe("orchestrator limit strict", () => {
  it.each(["1e4", "0x10", "5.9", "0", "01", " 5", "5 "])(
    "returns the list fallback for non-canonical %s",
    (value) => {
      expect(parseHistoryLimit(value, 10)).toEqual({ limit: 10 });
    },
  );

  it("preserves the detail metric fallback for invalid input", () => {
    expect(parseHistoryLimit(undefined, 1)).toEqual({ limit: 1 });
    expect(parseHistoryLimit("1e4", 1)).toEqual({ limit: 1 });
  });

  it("accepts positive integers up to the ceiling without clamping", () => {
    expect(parseHistoryLimit(5, 10)).toEqual({ limit: 5 });
    expect(parseHistoryLimit("50", 10)).toEqual({ limit: 50 });
    expect(parseHistoryLimit(MAX_HISTORY_LIMIT, 10)).toEqual({
      limit: MAX_HISTORY_LIMIT,
    });
  });

  it("REPORTS a clamp instead of silently reducing an over-max request", () => {
    expect(parseHistoryLimit("1000", 10)).toEqual({
      limit: MAX_HISTORY_LIMIT,
      clampedFrom: 1000,
    });
    expect(parseHistoryLimit(101, 10)).toEqual({
      limit: MAX_HISTORY_LIMIT,
      clampedFrom: 101,
    });
    expect(parseHistoryLimit(Number.MAX_SAFE_INTEGER + 1, 10)).toEqual({
      limit: 10,
    });
  });
});

describe("parseHistoryOffset", () => {
  it("accepts canonical non-negative integers", () => {
    expect(parseHistoryOffset(0)).toBe(0);
    expect(parseHistoryOffset(25)).toBe(25);
    expect(parseHistoryOffset("0")).toBe(0);
    expect(parseHistoryOffset("120")).toBe(120);
  });

  it.each([undefined, null, -1, 2.5, "01", "-3", "1e2", " 5", {}])(
    "starts from the top for non-canonical %s",
    (value) => {
      expect(parseHistoryOffset(value)).toBe(0);
    },
  );
});

describe("paginateHistory", () => {
  const items = Array.from({ length: 30 }, (_, i) => i);

  it("windows with the pre-slice total and a continuation flag", () => {
    const page1 = paginateHistory(items, 0, 10);
    expect(page1.page).toEqual(items.slice(0, 10));
    expect(page1.total).toBe(30);
    expect(page1.hasMore).toBe(true);

    const page3 = paginateHistory(items, 20, 10);
    expect(page3.page).toEqual(items.slice(20));
    expect(page3.hasMore).toBe(false);
  });

  it("an offset past the end yields an empty page but keeps the true total", () => {
    const past = paginateHistory(items, 100, 10);
    expect(past.page).toEqual([]);
    expect(past.total).toBe(30);
    expect(past.hasMore).toBe(false);
  });

  it("reassembles the complete list losslessly across pages", () => {
    const reassembled = [
      ...paginateHistory(items, 0, 7).page,
      ...paginateHistory(items, 7, 7).page,
      ...paginateHistory(items, 14, 7).page,
      ...paginateHistory(items, 21, 7).page,
      ...paginateHistory(items, 28, 7).page,
    ];
    expect(reassembled).toEqual(items);
  });
});
