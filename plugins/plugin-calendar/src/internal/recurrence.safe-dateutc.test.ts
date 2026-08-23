/**
 * Regression for Date.UTC 0-99 year handling in calendar recurrence helpers.
 */
import { describe, expect, it } from "vitest";

describe("calendar recurrence Date.UTC 0-99 regression", () => {
  it("Date.UTC 5 maps to 1905 but setUTCFullYear maps to 5", () => {
    expect(new Date(Date.UTC(5, 1, 1)).getUTCFullYear()).toBe(1905);
    const d = new Date(0);
    d.setUTCFullYear(5, 1, 1);
    expect(d.getUTCFullYear()).toBe(5);
  });

  it("Date.UTC 0 maps to 1900 but setUTCFullYear maps to 0", () => {
    expect(new Date(Date.UTC(0, 0, 1)).getUTCFullYear()).toBe(1900);
    const d = new Date(0);
    d.setUTCFullYear(0, 0, 1);
    expect(d.getUTCFullYear()).toBe(0);
  });

  it("daysInMonth via setUTCFullYear handles year 5", () => {
    const d = new Date(0);
    d.setUTCFullYear(5, 2, 0);
    d.setUTCHours(12, 0, 0, 0);
    expect(d.getUTCDate()).toBe(28);
  });
});
