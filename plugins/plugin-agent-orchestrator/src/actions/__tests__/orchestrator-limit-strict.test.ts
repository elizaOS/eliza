/** Deterministically exercises the TASKS history limit parser used by the action. */
import { describe, expect, it } from "vitest";
import { parseHistoryLimit } from "../tasks-history-limit";

describe("orchestrator limit strict", () => {
  it.each(["1e4", "0x10", "5.9", "0", "01", " 5", "5 "])(
    "returns the list fallback for non-canonical %s",
    (value) => {
      expect(parseHistoryLimit(value, 10)).toBe(10);
    },
  );

  it("preserves the detail metric fallback for invalid input", () => {
    expect(parseHistoryLimit(undefined, 1)).toBe(1);
    expect(parseHistoryLimit("1e4", 1)).toBe(1);
  });

  it("accepts positive integers and clamps large canonical values", () => {
    expect(parseHistoryLimit(5, 10)).toBe(5);
    expect(parseHistoryLimit("50", 10)).toBe(50);
    expect(parseHistoryLimit("1000", 10)).toBe(100);
    expect(parseHistoryLimit(Number.MAX_SAFE_INTEGER + 1, 10)).toBe(10);
  });
});
