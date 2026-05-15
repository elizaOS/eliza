import { describe, expect, it } from "vitest";
import {
  defaultVoiceQuantForTier,
  ELIZA_1_HF_REPO,
  ELIZA_1_TIER_IDS,
  ELIZA_1_VISION_TIER_IDS,
  findCatalogModel,
  MODEL_CATALOG,
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

  it("returns an empty OmniVoice ladder for Kokoro-only small tiers", () => {
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
  it("returns Q8_0 for large tiers (matches publish path workstation default)", () => {
    for (const id of LARGE_TIERS) {
      expect(defaultVoiceQuantForTier(id)).toBe("Q8_0");
    }
  });
});

describe("Eliza-1 runtime quant metadata", () => {
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

describe("Eliza-1 vision tier policy", () => {
  it("advertises vision only for tiers with a staged image mmproj contract", () => {
    const visionIds = new Set<string>(ELIZA_1_VISION_TIER_IDS);
    for (const id of ELIZA_1_TIER_IDS) {
      const model = findCatalogModel(id);
      const components = model?.sourceModel?.components;
      if (visionIds.has(id)) {
        const tier = id.slice("eliza-1-".length);
        expect(components?.vision).toEqual({
          repo: ELIZA_1_HF_REPO,
          file: `bundles/${tier}/vision/mmproj-${tier}.gguf`,
        });
      } else {
        expect(components?.vision).toBeUndefined();
      }
    }
  });
});
