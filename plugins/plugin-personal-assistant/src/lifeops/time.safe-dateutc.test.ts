/**
 * Regression for PA Date.UTC 0-99 handling.
 */
import { describe, expect, it } from "vitest";
describe("pa Date.UTC safe", () => {
  it("Date.UTC 5 -> 1905 vs setUTCFullYear 5 -> 5", () => {
    expect(new Date(Date.UTC(5, 0, 1)).getUTCFullYear()).toBe(1905);
    const d = new Date(0);
    d.setUTCFullYear(5, 0, 1);
    expect(d.getUTCFullYear()).toBe(5);
  });
  it("Date.UTC 0 -> 1900 vs setUTCFullYear 0 -> 0", () => {
    expect(new Date(Date.UTC(0, 0, 1)).getUTCFullYear()).toBe(1900);
    const d = new Date(0);
    d.setUTCFullYear(0, 0, 1);
    expect(d.getUTCFullYear()).toBe(0);
  });
});
