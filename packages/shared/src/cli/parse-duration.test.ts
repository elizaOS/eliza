/**
 * Duration string parser used by CLI/config knobs. Unit suffixes must convert
 * to the right millisecond count, the default unit applies only when no suffix
 * is given, and malformed/negative input must throw rather than silently
 * yielding a bogus timeout.
 */
import { describe, expect, it } from "vitest";
import { parseDurationMs } from "./parse-duration";

describe("parseDurationMs", () => {
  it("converts each unit suffix to milliseconds", () => {
    expect(parseDurationMs("500ms")).toBe(500);
    expect(parseDurationMs("2s")).toBe(2000);
    expect(parseDurationMs("3m")).toBe(180_000);
    expect(parseDurationMs("1h")).toBe(3_600_000);
    expect(parseDurationMs("1d")).toBe(86_400_000);
    expect(parseDurationMs("1.5s")).toBe(1500);
  });

  it("uses the default unit only when no suffix is present", () => {
    expect(parseDurationMs("250")).toBe(250); // default ms
    expect(parseDurationMs("5", { defaultUnit: "s" })).toBe(5000);
    expect(parseDurationMs("5s", { defaultUnit: "m" })).toBe(5000); // suffix wins
  });

  it("throws on empty / malformed / negative input", () => {
    expect(() => parseDurationMs("")).toThrow();
    expect(() => parseDurationMs("abc")).toThrow();
    expect(() => parseDurationMs("10x")).toThrow();
    expect(() => parseDurationMs("-5s")).toThrow();
  });
});
