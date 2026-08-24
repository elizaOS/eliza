/**
 * Unit tests for formatUsd display helper.
 * Validates currency string formatting, numeric string parsing, and fallback on invalid amounts.
 */
import { describe, expect, it } from "vitest";
import { formatUsd } from "./format-usd.ts";

describe("formatUsd", () => {
  it("formats integer numbers as USD currency", () => {
    expect(formatUsd(10)).toBe("$10.00");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(1250)).toBe("$1,250.00");
  });

  it("formats decimal numbers as USD currency", () => {
    expect(formatUsd(19.99)).toBe("$19.99");
    expect(formatUsd(0.5)).toBe("$0.50");
  });

  it("parses and formats numeric strings", () => {
    expect(formatUsd("42.50")).toBe("$42.50");
    expect(formatUsd("100")).toBe("$100.00");
  });

  it("returns em-dash fallback for null and undefined", () => {
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(undefined)).toBe("—");
  });

  it("returns em-dash fallback for non-finite or invalid numbers", () => {
    expect(formatUsd(Number.NaN)).toBe("—");
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatUsd(Number.NEGATIVE_INFINITY)).toBe("—");
    expect(formatUsd("not-a-number")).toBe("—");
  });
});
