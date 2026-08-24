import { describe, expect, it } from "vitest";
import { parseOrgCreditBalance } from "./agent-billing-numeric.js";

describe("parseOrgCreditBalance", () => {
  it("parses numeric string and number", () => {
    expect(parseOrgCreditBalance("25.00")).toBe(25);
    expect(parseOrgCreditBalance(42)).toBe(42);
    expect(parseOrgCreditBalance("0")).toBe(0);
  });

  it("throws on empty or missing", () => {
    expect(() => parseOrgCreditBalance(null)).toThrow(/empty or missing/);
    expect(() => parseOrgCreditBalance(undefined)).toThrow(/empty or missing/);
    expect(() => parseOrgCreditBalance("")).toThrow(/empty or missing/);
    expect(() => parseOrgCreditBalance("   ")).toThrow(/empty or missing/);
  });

  it("throws on non-finite", () => {
    expect(() => parseOrgCreditBalance("NaN")).toThrow(/finite/);
    expect(() => parseOrgCreditBalance("Infinity")).toThrow(/finite/);
    expect(() => parseOrgCreditBalance("bad")).toThrow(/finite/);
  });

  it("uses custom fieldName in message", () => {
    expect(() => parseOrgCreditBalance(null, "my_field")).toThrow(/my_field/);
  });
});
