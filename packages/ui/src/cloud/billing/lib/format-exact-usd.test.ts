import { describe, expect, it } from "vitest";
import { formatExactUsd } from "./format-exact-usd";

describe("formatExactUsd", () => {
  it.each([
    ["0", "$0.00"],
    ["12.500000", "$12.50"],
    ["0.123456", "$0.123456"],
    [
      "900719925474099312345678.123456",
      "$900,719,925,474,099,312,345,678.123456",
    ],
  ])("formats %s without losing exact digits", (value, expected) => {
    expect(formatExactUsd(value)).toBe(expected);
  });

  it.each(["", "01", "-1", "+1", "1.", ".1", "NaN", "Infinity"])(
    "fails closed for non-canonical decimal %s",
    (value) => {
      expect(formatExactUsd(value)).toBe("\u2014");
    },
  );
});
