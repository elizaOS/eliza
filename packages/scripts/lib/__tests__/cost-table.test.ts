import { describe, expect, it } from "vitest";
import { formatUsd } from "../cost-table.ts";

describe("formatUsd", () => {
  it("formats finite amounts with 4 fractional digits", () => {
    expect(formatUsd(0)).toBe("$0.0000");
    expect(formatUsd(1.23456)).toBe("$1.2346");
    expect(formatUsd(123.45)).toBe("$123.4500");
  });

  it("handles non-finite amounts with a placeholder", () => {
    expect(formatUsd(NaN)).toBe("$?.????");
    expect(formatUsd(Infinity)).toBe("$?.????");
    expect(formatUsd(-Infinity)).toBe("$?.????");
  });
});
