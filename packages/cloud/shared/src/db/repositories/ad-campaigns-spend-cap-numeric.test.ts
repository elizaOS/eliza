/**
 * Exercises the fail-closed numeric boundary for the ad-account spend-cap
 * enforcement reads in AdCampaignsRepository (#13415).
 */
import { describe, expect, test } from "bun:test";
import {
  parseAdAccountSpendCapCredits,
  parseAdCampaignSpendCapCredits,
  parseAdCampaignsAllocatedTotal,
} from "./ad-campaigns-spend-cap-numeric";

describe("parseAdAccountSpendCapCredits", () => {
  test("parses a well-formed NUMERIC string", () => {
    expect(parseAdAccountSpendCapCredits("100.00")).toBe(100);
  });

  test("parses a numeric value", () => {
    expect(parseAdAccountSpendCapCredits(250)).toBe(250);
  });

  test("parses an explicit zero cap (domain zero is allowed)", () => {
    expect(parseAdAccountSpendCapCredits("0.00")).toBe(0);
    expect(parseAdAccountSpendCapCredits(0)).toBe(0);
  });

  test("throws on 'NaN'::numeric round-trip instead of returning NaN", () => {
    expect(() => parseAdAccountSpendCapCredits("NaN")).toThrow(/not a valid NUMERIC/);
  });

  test("throws on Infinity / non-finite input", () => {
    expect(() => parseAdAccountSpendCapCredits(Number.POSITIVE_INFINITY)).toThrow(
      /not a finite number/,
    );
    expect(() => parseAdAccountSpendCapCredits("Infinity")).toThrow(/not a valid NUMERIC/);
  });

  test("throws on JS-only coercions Number() would otherwise accept", () => {
    expect(() => parseAdAccountSpendCapCredits("1e3")).toThrow(/not a valid NUMERIC/);
    expect(() => parseAdAccountSpendCapCredits("0x10")).toThrow(/not a valid NUMERIC/);
  });

  test("throws on negative caps instead of understating the money gate", () => {
    expect(() => parseAdAccountSpendCapCredits("-1.00")).toThrow(/not a valid NUMERIC|negative/);
    expect(() => parseAdAccountSpendCapCredits(-1)).toThrow(/negative/);
  });

  test("throws on null / undefined / empty / whitespace (missing cap)", () => {
    expect(() => parseAdAccountSpendCapCredits(null)).toThrow(/empty or missing/);
    expect(() => parseAdAccountSpendCapCredits(undefined)).toThrow(/empty or missing/);
    expect(() => parseAdAccountSpendCapCredits("")).toThrow(/empty or missing/);
    expect(() => parseAdAccountSpendCapCredits("   ")).toThrow(/empty or missing/);
  });

  test("names the column in the error so corruption is identifiable", () => {
    expect(() => parseAdAccountSpendCapCredits("corrupt")).toThrow(/spend_cap_credits/);
  });
});

describe("parseAdCampaignsAllocatedTotal", () => {
  test("parses a well-formed SUM string", () => {
    expect(parseAdCampaignsAllocatedTotal("500.00")).toBe(500);
  });

  test("treats a genuinely-absent SUM (no campaigns) as domain zero", () => {
    expect(parseAdCampaignsAllocatedTotal(null)).toBe(0);
    expect(parseAdCampaignsAllocatedTotal(undefined)).toBe(0);
    expect(parseAdCampaignsAllocatedTotal("")).toBe(0);
    expect(parseAdCampaignsAllocatedTotal("   ")).toBe(0);
  });

  test("throws on a present-but-corrupt SUM instead of poisoning the total", () => {
    expect(() => parseAdCampaignsAllocatedTotal("NaN")).toThrow(/credits_allocated total/);
    expect(() => parseAdCampaignsAllocatedTotal(Number.NaN)).toThrow(/not a finite number/);
  });

  test("throws on a negative SUM so corrupt allocation totals cannot understate spend", () => {
    expect(() => parseAdCampaignsAllocatedTotal("-100.00")).toThrow(/not a valid NUMERIC|negative/);
    expect(() => parseAdCampaignsAllocatedTotal(-100)).toThrow(/negative/);
  });
});

describe("parseAdCampaignSpendCapCredits", () => {
  test("parses a campaign-level cap with a campaign-specific error boundary", () => {
    expect(parseAdCampaignSpendCapCredits("75.00")).toBe(75);
    expect(() => parseAdCampaignSpendCapCredits("NaN")).toThrow(/campaign spend_cap_credits/);
  });

  test("throws on a negative campaign-level cap", () => {
    expect(() => parseAdCampaignSpendCapCredits("-25.00")).toThrow(/not a valid NUMERIC|negative/);
    expect(() => parseAdCampaignSpendCapCredits(-25)).toThrow(/negative/);
  });
});

describe("spend-cap fail-open regression (corrupt cap / allocated total)", () => {
  // The pre-fix enforcement did: `allocated > Number(cap) + 1e-9` with a bare
  // Number() read. Prove that a corrupt cap or a corrupt allocated SUM makes the
  // gate FALSE (silently permitting unbounded spend), and that the fail-closed
  // readers throw on the exact same inputs.

  test("bare Number(cap) comparison would silently fail OPEN on a corrupt cap", () => {
    const corruptCap = Number("NaN"); // 'NaN'::numeric round-trip
    const allocated = 999_999;
    // The real gate: if (allocated > cap + 1e-9) return cap_exceeded.
    expect(allocated > corruptCap + 1e-9).toBe(false); // gate bypassed -> spend allowed
  });

  test("bare Number(total) SUM would silently fail OPEN on a corrupt allocated row", () => {
    const corruptTotal = Number("NaN");
    const cap = 100;
    const allocated = corruptTotal + 50;
    expect(allocated > cap + 1e-9).toBe(false); // gate bypassed -> spend allowed
  });

  test("the fail-closed readers throw on those same corrupt inputs (deny, not permit)", () => {
    expect(() => parseAdAccountSpendCapCredits("NaN")).toThrow();
    expect(() => parseAdCampaignsAllocatedTotal("NaN")).toThrow();
  });

  test("a healthy cap + healthy total still enforce the gate correctly", () => {
    const cap = parseAdAccountSpendCapCredits("100.00");
    const allocated = parseAdCampaignsAllocatedTotal("150.00");
    expect(allocated > cap + 1e-9).toBe(true); // gate fires -> cap_exceeded
  });
});
