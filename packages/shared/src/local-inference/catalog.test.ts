import { describe, expect, it } from "vitest";
import {
  defaultVoiceQuantForTier,
  ELIZA_1_TIER_IDS,
  MODEL_CATALOG,
  type OmniVoiceQuantLevel,
  voiceQuantLadderForTier,
} from "./catalog.js";

const SMALL_TIERS = ["eliza-1-0_8b", "eliza-1-2b", "eliza-1-4b"] as const;
const LARGE_TIERS = [
  "eliza-1-9b",
  "eliza-1-27b",
  "eliza-1-27b-256k",
] as const;
const OMNIVOICE_TIERS = LARGE_TIERS;

describe("voiceQuantLadderForTier", () => {
  it("covers every canonical tier id", () => {
    // The publish wiring iterates the ladder per tier; a missing key would
    // silently skip a tier's voice staging.
    for (const id of ELIZA_1_TIER_IDS) {
      const ladder = voiceQuantLadderForTier(id);
      expect(Array.isArray(ladder)).toBe(true);
    }
  });

  it("does not publish OmniVoice ladders for Kokoro-only small tiers", () => {
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
    for (const id of OMNIVOICE_TIERS) {
      const ladder = voiceQuantLadderForTier(id);
      const def = defaultVoiceQuantForTier(id);
      expect(ladder).toContain(def);
    }
  });
});

describe("defaultVoiceQuantForTier", () => {
  it("keeps a Q4_K_M OmniVoice default if a small tier enables OmniVoice later", () => {
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

describe("Eliza-1 runtime quant metadata", () => {
  it("ships every text tier at least at the 128k half-context floor", () => {
    for (const id of ELIZA_1_TIER_IDS) {
      const entry = MODEL_CATALOG.find((model) => model.id === id);
      expect(entry?.contextLength).toBeGreaterThanOrEqual(131072);
      expect(entry?.ggufFile).not.toMatch(/-(32k|64k)\.gguf$/);
      if (id === "eliza-1-27b-256k") {
        expect(entry?.contextLength).toBe(262144);
        expect(entry?.ggufFile).toBe("text/eliza-1-27b-256k.gguf");
      } else {
        expect(entry?.contextLength).toBe(131072);
        expect(entry?.ggufFile).toBe(
          `text/${id.replace("eliza-1-", "eliza-1-")}-128k.gguf`,
        );
      }
    }
  });

  it("uses QJL K-cache and TurboQuant V-cache for every chat tier", () => {
    for (const id of ELIZA_1_TIER_IDS) {
      const entry = MODEL_CATALOG.find((model) => model.id === id);
      expect(entry?.runtime?.kvCache?.typeK).toBe("qjl1_256");
      expect(entry?.runtime?.kvCache?.typeV).toBe("tbq3_0");
      expect(entry?.runtime?.optimizations?.requiresKernel).toContain(
        "qjl_full",
      );
      expect(entry?.runtime?.optimizations?.requiresKernel).toContain("turbo3");
      expect(entry?.runtime?.optimizations?.requiresKernel).toContain(
        "polarquant",
      );
    }
  });
});
