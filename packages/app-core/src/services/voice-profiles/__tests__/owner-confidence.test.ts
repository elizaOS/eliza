import { describe, expect, it } from "vitest";
import {
  type OwnerConfidenceInput,
  scoreOwnerConfidence,
} from "../owner-confidence.ts";

function input(overrides: Partial<OwnerConfidenceInput> = {}): OwnerConfidenceInput {
  return {
    voiceSimilarityToOwnerProfile: 0,
    deviceTrustLevel: "low",
    recentlyAuthenticated: false,
    contextExpectsOwner: false,
    challengeRecentlyPassed: false,
    ...overrides,
  };
}

describe("scoreOwnerConfidence", () => {
  it("zero score with no signals", () => {
    const r = scoreOwnerConfidence(input());
    expect(r.score).toBe(0);
    expect(r.reasons).toEqual([]);
  });

  it("challenge alone clears the 0.4 floor", () => {
    const r = scoreOwnerConfidence(input({ challengeRecentlyPassed: true }));
    expect(r.score).toBeGreaterThanOrEqual(0.4);
    expect(r.reasons).toContain("challenge-recently-passed");
  });

  it("recent auth contributes a meaningful weight", () => {
    const r = scoreOwnerConfidence(input({ recentlyAuthenticated: true }));
    expect(r.score).toBeGreaterThanOrEqual(0.3);
    expect(r.reasons).toContain("recently-authenticated");
  });

  it("voice similarity alone cannot reach 0.6", () => {
    const r = scoreOwnerConfidence(input({ voiceSimilarityToOwnerProfile: 1 }));
    expect(r.score).toBeLessThan(0.6);
  });

  it("device trust contributes the expected step", () => {
    const lo = scoreOwnerConfidence(input({ deviceTrustLevel: "low" })).score;
    const mid = scoreOwnerConfidence(input({ deviceTrustLevel: "medium" })).score;
    const hi = scoreOwnerConfidence(input({ deviceTrustLevel: "high" })).score;
    expect(mid).toBeGreaterThan(lo);
    expect(hi).toBeGreaterThan(mid);
  });

  it("context-expects-owner adds a small weight", () => {
    const off = scoreOwnerConfidence(input()).score;
    const on = scoreOwnerConfidence(input({ contextExpectsOwner: true })).score;
    expect(on).toBeGreaterThan(off);
  });

  it("clamps score to [0,1]", () => {
    const r = scoreOwnerConfidence(
      input({
        challengeRecentlyPassed: true,
        recentlyAuthenticated: true,
        voiceSimilarityToOwnerProfile: 1,
        deviceTrustLevel: "high",
        contextExpectsOwner: true,
      }),
    );
    expect(r.score).toBeLessThanOrEqual(1);
    expect(r.score).toBeGreaterThan(0.9);
  });

  it("clamps negative voice similarity", () => {
    const r = scoreOwnerConfidence(
      input({ voiceSimilarityToOwnerProfile: -0.5 }),
    );
    expect(r.score).toBe(0);
  });
});
