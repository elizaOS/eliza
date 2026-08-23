import { describe, expect, it } from "vitest";
import { parseDurationMs } from "./parse-duration.ts";

describe("parseDurationMs", () => {
  it("parses unit suffixes", () => {
    expect(parseDurationMs("500ms")).toBe(500);
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("5m")).toBe(300_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
    expect(parseDurationMs("1d")).toBe(86_400_000);
  });

  it("defaults bare numbers to ms", () => {
    expect(parseDurationMs("100")).toBe(100);
  });

  it("honors the configured default unit", () => {
    expect(parseDurationMs("5", { defaultUnit: "s" })).toBe(5_000);
    expect(parseDurationMs("2", { defaultUnit: "h" })).toBe(7_200_000);
  });

  it("parses fractional values", () => {
    expect(parseDurationMs("1.5s")).toBe(1_500);
    expect(parseDurationMs("0.5m")).toBe(30_000);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(parseDurationMs(" 5S ")).toBe(5_000);
    expect(parseDurationMs("2M")).toBe(120_000);
  });

  it("rejects invalid input", () => {
    for (const bad of ["", "  ", "abc", "5x", "-3s", "1.2.3", "s"]) {
      expect(() => parseDurationMs(bad)).toThrow();
    }
  });

  it("rejects non-string input", () => {
    expect(() => parseDurationMs(42 as never)).toThrow("invalid duration");
  });
});
