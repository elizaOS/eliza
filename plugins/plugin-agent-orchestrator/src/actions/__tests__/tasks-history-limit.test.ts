import { describe, expect, it } from "vitest";
import { parseHistoryLimit } from "./tasks-history-limit.ts";

describe("parseHistoryLimit", () => {
  it("accepts positive integers and caps at 100", () => {
    expect(parseHistoryLimit(5, 10)).toBe(5);
    expect(parseHistoryLimit(100, 10)).toBe(100);
    expect(parseHistoryLimit(500, 10)).toBe(100);
  });

  it("accepts positive integer strings", () => {
    expect(parseHistoryLimit("7", 10)).toBe(7);
    expect(parseHistoryLimit("250", 10)).toBe(100);
  });

  it("rejects non-positive and non-integer numbers", () => {
    expect(parseHistoryLimit(0, 10)).toBe(10);
    expect(parseHistoryLimit(-3, 10)).toBe(10);
    expect(parseHistoryLimit(1.5, 10)).toBe(10);
    expect(parseHistoryLimit(Number.NaN, 10)).toBe(10);
  });

  it("rejects malformed strings", () => {
    expect(parseHistoryLimit("abc", 10)).toBe(10);
    expect(parseHistoryLimit("0", 10)).toBe(10);
    expect(parseHistoryLimit("1.5", 10)).toBe(10);
    expect(parseHistoryLimit("", 10)).toBe(10);
    expect(parseHistoryLimit(null, 10)).toBe(10);
    expect(parseHistoryLimit(undefined, 10)).toBe(10);
  });
});
