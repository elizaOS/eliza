import { describe, expect, it } from "vitest";
import {
  defaultVoiceQuantForTier,
  ELIZA_1_TIER_IDS,
  type OmniVoiceQuantLevel,
  voiceQuantLadderForTier,
} from "./catalog.js";

const SMALL_TIERS = ["eliza-1-0_8b", "eliza-1-2b", "eliza-1-4b"] as const;
const LARGE_TIERS = [
  "eliza-1-9b",
  "eliza-1-27b",
  "eliza-1-27b-256k",
  "eliza-1-27b-1m",
] as const;

describe("voiceQuantLadderForTier", () => {
  it("covers every canonical tier id", () => {
    // The publish wiring iterates the ladder per tier; a missing key would
    // silently skip a tier's voice staging.
    for (const id of ELIZA_1_TIER_IDS) {
      const ladder = voiceQuantLadderForTier(id);
      expect(Array.isArray(ladder)).toBe(true);
    }
  });

  it("returns no OmniVoice ladder for Kokoro-only small tiers", () => {
    for (const id of SMALL_TIERS) {
      expect(voiceQuantLadderForTier(id)).toEqual([]);
    }
  });

  it("returns the full Q3..Q8 ladder for OmniVoice tiers", () => {
    const expected: OmniVoiceQuantLevel[] = [
      "Q3_K_M",
      "Q4_K_M",
      "Q5_K_M",
      "Q6_K",
      "Q8_0",
    ];
    for (const id of LARGE_TIERS) {
      expect(voiceQuantLadderForTier(id)).toEqual(expected);
    }
  });

  it("includes the runtime default quant in the published ladder", () => {
    // The runtime selects via defaultVoiceQuantForTier; if the default isn't
    // in the ladder the runtime would request a file that the publish path
    // never staged.
    for (const id of LARGE_TIERS) {
      const ladder = voiceQuantLadderForTier(id);
      const def = defaultVoiceQuantForTier(id);
      expect(ladder).toContain(def);
    }
  });
});

describe("defaultVoiceQuantForTier", () => {
  it("returns Q4_K_M for mobile tiers (matches publish path mobile sweet spot)", () => {
    for (const id of SMALL_TIERS) {
      expect(defaultVoiceQuantForTier(id)).toBe("Q4_K_M");
    }
  });

  it("returns Q8_0 for large tiers (matches publish path workstation default)", () => {
    for (const id of LARGE_TIERS) {
      expect(defaultVoiceQuantForTier(id)).toBe("Q8_0");
    }
  });
});
