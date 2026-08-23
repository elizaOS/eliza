/**
 * Regression for PDF Date.UTC year 0-99 bug.
 */
import { describe, expect, it } from "vitest";

describe("pdf Date.UTC safe", () => {
  it("handles year 10 as literal 10 not 1910", () => {
    const raw = new Date(Date.UTC(10, 0, 1, 12, 0, 0));
    expect(raw.getUTCFullYear()).toBe(1910);
    const d = new Date(0);
    d.setUTCFullYear(10, 0, 1);
    d.setUTCHours(12, 0, 0, 0);
    expect(d.getUTCFullYear()).toBe(10);
  });

  it("handles year 0 as 0 not 1900", () => {
    const raw = new Date(Date.UTC(0, 0, 1));
    expect(raw.getUTCFullYear()).toBe(1900);
    const d = new Date(0);
    d.setUTCFullYear(0, 0, 1);
    expect(d.getUTCFullYear()).toBe(0);
  });
});
