import { describe, it, expect } from "vitest";
import { getTransactionRecommendation, formatServiceSummary } from "./recommendations.js";

describe("getTransactionRecommendation", () => {
  it("returns safe for amount within limits of RECOMMENDED service", () => {
    const rec = getTransactionRecommendation(80, 1000);
    expect(rec.safe).toBe(true);
    expect(rec.verdict.verdict).toBe("RECOMMENDED");
    expect(rec.message).toContain("within safe limits");
  });

  it("returns unsafe for amount exceeding limits", () => {
    const rec = getTransactionRecommendation(80, 6000);
    expect(rec.safe).toBe(false);
    expect(rec.message).toContain("exceeds recommended max");
  });

  it("returns safe when no amount specified", () => {
    const rec = getTransactionRecommendation(80);
    expect(rec.safe).toBe(true);
    expect(rec.message).toContain("max transaction");
  });

  it("returns not recommended for very low scores", () => {
    const rec = getTransactionRecommendation(10, 1);
    expect(rec.verdict.verdict).toBe("NOT_RECOMMENDED");
    expect(rec.safe).toBe(false); // maxTransaction is 0, so any amount is unsafe
    expect(rec.message).toContain("not recommended");
  });

  it("returns safe for NOT_RECOMMENDED with no amount", () => {
    const rec = getTransactionRecommendation(10);
    // safe is true because requestedAmount is undefined
    expect(rec.safe).toBe(true);
    expect(rec.message).toContain("not recommended");
  });

  it("USABLE service allows up to $1000", () => {
    expect(getTransactionRecommendation(60, 1000).safe).toBe(true);
    expect(getTransactionRecommendation(60, 1001).safe).toBe(false);
  });

  it("CAUTION service allows up to $100", () => {
    expect(getTransactionRecommendation(30, 100).safe).toBe(true);
    expect(getTransactionRecommendation(30, 101).safe).toBe(false);
  });

  it("handles $0 amount", () => {
    const rec = getTransactionRecommendation(80, 0);
    expect(rec.safe).toBe(true);
  });
});

describe("formatServiceSummary", () => {
  it("formats basic summary without flags", () => {
    const result = formatServiceSummary("test.com", 80, "HIGH", "RECOMMENDED", 5000, []);
    expect(result).toBe("test.com: Score 80/100 (HIGH). Verdict: RECOMMENDED (max $5000).");
  });

  it("includes warning flags but excludes info flags", () => {
    const result = formatServiceSummary(
      "test.com", 80, "HIGH", "RECOMMENDED", 5000,
      ["ENDPOINT_TIMEOUT", "PROTOCOL_COMPLIANT"]
    );
    expect(result).toContain("Flags: ENDPOINT_TIMEOUT.");
    expect(result).not.toContain("PROTOCOL_COMPLIANT");
  });

  it("excludes all positive/info flags", () => {
    const result = formatServiceSummary(
      "test.com", 80, "HIGH", "RECOMMENDED", 5000,
      ["HAS_COMPLETE_SCHEMA", "GOOD_DOCUMENTATION", "X402_V1"]
    );
    expect(result).not.toContain("Flags:");
  });
});