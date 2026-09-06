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

  it("supports spaces and word aliases for duration units", () => {
    expect(parseDurationMs("500 ms")).toBe(500);
    expect(parseDurationMs("20 seconds")).toBe(20_000);
    expect(parseDurationMs("15 secs")).toBe(15_000);
    expect(parseDurationMs("5 minutes")).toBe(300_000);
    expect(parseDurationMs("2 mins")).toBe(120_000);
    expect(parseDurationMs("3 hours")).toBe(10_800_000);
    expect(parseDurationMs("2 days")).toBe(172_800_000);
  });

  it("uses the default unit only when no suffix is present", () => {
    expect(parseDurationMs("250")).toBe(250); // default ms
    expect(parseDurationMs("5", { defaultUnit: "s" })).toBe(5000);
    expect(parseDurationMs("5s", { defaultUnit: "m" })).toBe(5000); // suffix wins
    expect(parseDurationMs("5 s", { defaultUnit: "m" })).toBe(5000); // spaced suffix wins
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

  it("rejects unsupported calendar and near-miss unit spellings", () => {
    expect(() => parseDurationMs("1 month")).toThrow("invalid duration");
    expect(() => parseDurationMs("1 months")).toThrow("invalid duration");
    expect(() => parseDurationMs("3 mo")).toThrow("invalid duration");
    expect(() => parseDurationMs("5 weeks")).toThrow("invalid duration");
    expect(() => parseDurationMs("1w")).toThrow("invalid duration");
    expect(() => parseDurationMs("1 year")).toThrow("invalid duration");
    expect(() => parseDurationMs("2 y")).toThrow("invalid duration");
    expect(() => parseDurationMs("1 secondz")).toThrow("invalid duration");
    expect(() => parseDurationMs("5 hourss")).toThrow("invalid duration");
    expect(() => parseDurationMs("5 m s")).toThrow("invalid duration");
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
