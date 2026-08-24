/**
 * Unit tests for scoreOwnerConfidence: per-signal weighting (challenge,
 * recent auth, the device-trust step, context expectation, and capped voice
 * similarity), the reason strings attached to each contributing signal, and
 * clamping of the final score to [0, 1].
 */
import { describe, expect, it } from "vitest";
import {
  type OwnerConfidenceInput,
  scoreOwnerConfidence,
} from "../owner-confidence.ts";

function input(
  overrides: Partial<OwnerConfidenceInput> = {},
): OwnerConfidenceInput {
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
    const mid = scoreOwnerConfidence(
      input({ deviceTrustLevel: "medium" }),
    ).score;
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

  it("challenge alone scores exactly its weight with only its reason", () => {
    const r = scoreOwnerConfidence(input({ challengeRecentlyPassed: true }));
    expect(r.score).toBe(0.45);
    expect(r.reasons).toEqual(["challenge-recently-passed"]);
  });

  it("recent auth alone scores exactly its weight with only its reason", () => {
    const r = scoreOwnerConfidence(input({ recentlyAuthenticated: true }));
    expect(r.score).toBe(0.35);
    expect(r.reasons).toEqual(["recently-authenticated"]);
  });

  it("full-similarity voice contributes exactly the cap and tags the reason", () => {
    const r = scoreOwnerConfidence(input({ voiceSimilarityToOwnerProfile: 1 }));
    expect(r.score).toBe(0.25);
    expect(r.reasons).toEqual(["voice-similarity:1.00"]);
  });

  it("partial voice similarity scales linearly inside the cap", () => {
    const r = scoreOwnerConfidence(
      input({ voiceSimilarityToOwnerProfile: 0.5 }),
    );
    expect(r.score).toBe(0.125);
    expect(r.reasons).toEqual(["voice-similarity:0.50"]);
  });

  it("voice similarity above one clamps to the same contribution as one", () => {
    const r = scoreOwnerConfidence(input({ voiceSimilarityToOwnerProfile: 7 }));
    expect(r.score).toBe(0.25);
    expect(r.reasons).toEqual(["voice-similarity:1.00"]);
  });

  it("device trust steps carry exact weights and tags; low adds nothing", () => {
    const low = scoreOwnerConfidence(input({ deviceTrustLevel: "low" }));
    expect(low.score).toBe(0);
    expect(low.reasons).toEqual([]);
    const medium = scoreOwnerConfidence(input({ deviceTrustLevel: "medium" }));
    expect(medium.score).toBe(0.1);
    expect(medium.reasons).toEqual(["device-trust:medium"]);
    const high = scoreOwnerConfidence(input({ deviceTrustLevel: "high" }));
    expect(high.score).toBe(0.2);
    expect(high.reasons).toEqual(["device-trust:high"]);
  });

  it("context expectation alone scores exactly its weight and tag", () => {
    const r = scoreOwnerConfidence(input({ contextExpectsOwner: true }));
    expect(r.score).toBe(0.1);
    expect(r.reasons).toEqual(["context-expects-owner"]);
  });

  it("reasons follow fixed signal order and the saturated total clamps to 1", () => {
    const r = scoreOwnerConfidence(
      input({
        challengeRecentlyPassed: true,
        recentlyAuthenticated: true,
        voiceSimilarityToOwnerProfile: 1,
        deviceTrustLevel: "high",
        contextExpectsOwner: true,
      }),
    );
    expect(r.score).toBe(1);
    expect(r.reasons).toEqual([
      "challenge-recently-passed",
      "recently-authenticated",
      "voice-similarity:1.00",
      "device-trust:high",
      "context-expects-owner",
    ]);
  });
});
