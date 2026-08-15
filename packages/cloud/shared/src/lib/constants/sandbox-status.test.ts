/** Exercises sandbox status date formatting with valid, absent, and invalid timestamps. */

import { describe, expect, test } from "vitest";
import { formatRelative, formatRelativeShort } from "./sandbox-status";

describe("sandbox status date formatters", () => {
  test("preserve null fallbacks", () => {
    expect(formatRelative(null)).toBe("Never");
    expect(formatRelativeShort(null)).toBe("—");
  });

  test("format valid recent dates", () => {
    const recent = new Date();

    expect(formatRelative(recent)).toBe("Just now");
    expect(formatRelativeShort(recent)).toBe("Just now");
  });

  test("use null fallbacks for invalid date strings", () => {
    expect(formatRelative("not-a-date")).toBe("Never");
    expect(formatRelativeShort("not-a-date")).toBe("—");
  });

  test("use null fallbacks for invalid Date objects", () => {
    const invalid = new Date(Number.NaN);

    expect(formatRelative(invalid)).toBe("Never");
    expect(formatRelativeShort(invalid)).toBe("—");
  });
});
