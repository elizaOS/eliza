import { describe, it, expect } from "vitest";
import { getTrustLevel, getVerdict, isScoreSafe } from "./trust-levels.js";

describe("getTrustLevel", () => {
  it("returns HIGH for score >= 75", () => {
    expect(getTrustLevel(75).level).toBe("HIGH");
    expect(getTrustLevel(100).level).toBe("HIGH");
    expect(getTrustLevel(90).level).toBe("HIGH");
  });

  it("returns MEDIUM for 50-74", () => {
    expect(getTrustLevel(50).level).toBe("MEDIUM");
    expect(getTrustLevel(74).level).toBe("MEDIUM");
  });

  it("returns LOW for 25-49", () => {
    expect(getTrustLevel(25).level).toBe("LOW");
    expect(getTrustLevel(49).level).toBe("LOW");
  });

  it("returns VERY_LOW for 0-24", () => {
    expect(getTrustLevel(0).level).toBe("VERY_LOW");
    expect(getTrustLevel(24).level).toBe("VERY_LOW");
  });

  it("clamps scores above 100 to HIGH", () => {
    expect(getTrustLevel(150).level).toBe("HIGH");
  });

  it("returns VERY_LOW for negative scores", () => {
    expect(getTrustLevel(-1).level).toBe("VERY_LOW");
    expect(getTrustLevel(-100).level).toBe("VERY_LOW");
  });

  it("returns VERY_LOW for NaN", () => {
    expect(getTrustLevel(NaN).level).toBe("VERY_LOW");
  });

  it("returns VERY_LOW for Infinity", () => {
    expect(getTrustLevel(Infinity).level).toBe("VERY_LOW");
    expect(getTrustLevel(-Infinity).level).toBe("VERY_LOW");
  });

  it("returns correct labels", () => {
    expect(getTrustLevel(80).label).toBe("High Trust");
    expect(getTrustLevel(60).label).toBe("Medium Trust");
    expect(getTrustLevel(30).label).toBe("Low Trust");
    expect(getTrustLevel(10).label).toBe("Very Low Trust");
  });
});

describe("getVerdict", () => {
  it("returns RECOMMENDED for >= 75", () => {
    expect(getVerdict(75).verdict).toBe("RECOMMENDED");
    expect(getVerdict(75).maxTransaction).toBe(5000);
  });

  it("returns USABLE for 50-74", () => {
    expect(getVerdict(50).verdict).toBe("USABLE");
    expect(getVerdict(50).maxTransaction).toBe(1000);
  });

  it("returns CAUTION for 25-49", () => {
    expect(getVerdict(25).verdict).toBe("CAUTION");
    expect(getVerdict(25).maxTransaction).toBe(100);
  });

  it("returns NOT_RECOMMENDED for 0-24", () => {
    expect(getVerdict(0).verdict).toBe("NOT_RECOMMENDED");
    expect(getVerdict(0).maxTransaction).toBe(0);
  });

  it("returns NOT_RECOMMENDED for NaN", () => {
    expect(getVerdict(NaN).verdict).toBe("NOT_RECOMMENDED");
  });

  it("returns NOT_RECOMMENDED for negative", () => {
    expect(getVerdict(-5).verdict).toBe("NOT_RECOMMENDED");
  });

  it("returns NOT_RECOMMENDED for Infinity", () => {
    expect(getVerdict(Infinity).verdict).toBe("NOT_RECOMMENDED");
  });

  it("handles boundary exactly at 75", () => {
    expect(getVerdict(74).verdict).toBe("USABLE");
    expect(getVerdict(75).verdict).toBe("RECOMMENDED");
  });

  it("handles boundary exactly at 50", () => {
    expect(getVerdict(49).verdict).toBe("CAUTION");
    expect(getVerdict(50).verdict).toBe("USABLE");
  });

  it("handles boundary exactly at 25", () => {
    expect(getVerdict(24).verdict).toBe("NOT_RECOMMENDED");
    expect(getVerdict(25).verdict).toBe("CAUTION");
  });
});

describe("isScoreSafe", () => {
  it("returns true when score meets threshold", () => {
    expect(isScoreSafe(50, 50)).toBe(true);
    expect(isScoreSafe(80, 50)).toBe(true);
  });

  it("returns false when score is below threshold", () => {
    expect(isScoreSafe(49, 50)).toBe(false);
  });

  it("returns false for NaN score", () => {
    expect(isScoreSafe(NaN, 50)).toBe(false);
  });

  it("returns false for Infinity score", () => {
    expect(isScoreSafe(Infinity, 50)).toBe(false);
  });

  it("returns false for NaN threshold", () => {
    expect(isScoreSafe(80, NaN)).toBe(false);
  });

  it("handles zero score with zero threshold", () => {
    expect(isScoreSafe(0, 0)).toBe(true);
  });
});