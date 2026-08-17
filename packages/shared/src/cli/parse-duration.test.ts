/**
 * Duration string parser used by CLI/config knobs. Unit suffixes must convert
 * to the right millisecond count, the default unit applies only when no suffix
 * is given, and malformed, negative, or overflowing input must throw rather
 * than silently yielding a bogus timeout.
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
    expect(() => parseDurationMs("   ")).toThrow();
    expect(() => parseDurationMs(null as unknown as string)).toThrow();
    expect(() => parseDurationMs(undefined as unknown as string)).toThrow();
    expect(() => parseDurationMs("abc")).toThrow();
    expect(() => parseDurationMs("10x")).toThrow();
    expect(() => parseDurationMs("-5s")).toThrow();
  });

  it.each(["s", "m", "h", "d"] as const)(
    "throws when %s conversion overflows milliseconds",
    (unit) => {
      expect(() => parseDurationMs(`1${"0".repeat(306)}${unit}`)).toThrow(
        "invalid duration",
      );
    },
  );

  it("rejects values exceeding MAX_SAFE_INTEGER", () => {
    expect(() => parseDurationMs("1000000000000000d")).toThrow(
      "invalid duration",
    );
    expect(() => parseDurationMs("10000000000000000ms")).toThrow(
      "invalid duration",
    );
    expect(parseDurationMs(`${Number.MAX_SAFE_INTEGER}ms`)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("checks overflow after applying the default unit", () => {
    expect(() =>
      parseDurationMs(`1${"0".repeat(306)}`, { defaultUnit: "m" }),
    ).toThrow("invalid duration");
  });
});
