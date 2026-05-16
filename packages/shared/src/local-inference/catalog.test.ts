import { describe, expect, it } from "vitest";
import {
  defaultVoiceQuantForTier,
  ELIZA_1_TIER_IDS,
  ELIZA_1_VISION_TIER_IDS,
  MODEL_CATALOG,
  type OmniVoiceQuantLevel,
  voiceQuantLadderForTier,
} from "./catalog.js";

const SMALL_TIERS = ["eliza-1-0_8b", "eliza-1-2b", "eliza-1-4b"] as const;
const LARGE_TIERS = ["eliza-1-9b", "eliza-1-27b"] as const;
const OMNIVOICE_TIERS = ELIZA_1_TIER_IDS;
const EXPECTED_DISPLAY_NAMES: Record<string, string> = {
  "eliza-1-0_8b": "eliza-1-0.8B",
  "eliza-1-2b": "eliza-1-2B",
  "eliza-1-4b": "eliza-1-4B",
  "eliza-1-9b": "eliza-1-9B",
  "eliza-1-27b": "eliza-1-27B",
};
const EXPECTED_CHAT_PARAMS: Record<string, string> = {
  "eliza-1-0_8b": "0.8B",
  "eliza-1-2b": "2B",
  "eliza-1-4b": "4B",
  "eliza-1-9b": "9B",
  "eliza-1-27b": "27B",
};

describe("voiceQuantLadderForTier", () => {
  it("covers every canonical tier id", () => {
    // The publish wiring iterates the ladder per tier; a missing key would
    // silently skip a tier's voice staging.
    for (const id of ELIZA_1_TIER_IDS) {
      const ladder = voiceQuantLadderForTier(id);
      expect(Array.isArray(ladder)).toBe(true);
    }
  });

  it("returns the narrow mobile ladder for small OmniVoice tiers", () => {
    const expected: OmniVoiceQuantLevel[] = ["Q3_K_M", "Q4_K_M", "Q5_K_M"];
    for (const id of SMALL_TIERS) {
      expect(voiceQuantLadderForTier(id)).toEqual(expected);
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
  it("keeps a Q4_K_M OmniVoice default for small tiers", () => {
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
  it("keeps stable ids but exposes requested size-cased display names", () => {
    for (const id of ELIZA_1_TIER_IDS) {
      const entry = MODEL_CATALOG.find((model) => model.id === id);
      expect(entry?.displayName).toBe(EXPECTED_DISPLAY_NAMES[id]);
      expect(entry?.params).toBe(EXPECTED_CHAT_PARAMS[id]);
      expect(entry?.ggufFile).toContain(id);
    }
  });

  it("ships every active text tier at the 128k floor", () => {
    for (const id of ELIZA_1_TIER_IDS) {
      const entry = MODEL_CATALOG.find((model) => model.id === id);
      expect(entry?.contextLength).toBeGreaterThanOrEqual(131072);
      expect(entry?.ggufFile).not.toMatch(/-(32k|64k)\.gguf$/);
      expect(entry?.contextLength).toBe(131072);
      expect(entry?.ggufFile).toBe(`text/${id}-128k.gguf`);
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

  it("does not attach a DFlash companion to the 0.8B tier", () => {
    const entry = MODEL_CATALOG.find((model) => model.id === "eliza-1-0_8b");

    expect(entry?.companionModelIds ?? []).toEqual([]);
    expect(entry?.runtime?.dflash).toBeUndefined();
    expect(entry?.runtime?.optimizations?.requiresKernel).not.toContain(
      "dflash",
    );
    expect(
      MODEL_CATALOG.some((model) => model.id === "eliza-1-0_8b-drafter"),
    ).toBe(false);
    expect(entry?.sourceModel?.components.drafter).toBeUndefined();
  });

  it("gates M-RoPE DFlash tiers until the verifier path is hardware-validated", () => {
    for (const id of [
      "eliza-1-2b",
      "eliza-1-4b",
      "eliza-1-9b",
      "eliza-1-27b",
    ]) {
      const entry = MODEL_CATALOG.find((model) => model.id === id);
      expect(entry?.runtime?.dflash?.disabledReason).toMatch(/7631/);
    }
  });

  it("points every voice-enabled tier at the bundled Silero VAD GGUF", () => {
    for (const id of ELIZA_1_TIER_IDS) {
      const entry = MODEL_CATALOG.find((model) => model.id === id);
      expect(entry?.sourceModel?.components.vad?.file).toBe(
        `bundles/${id.slice("eliza-1-".length)}/vad/silero-vad-v5.gguf`,
      );
    }
  });

  it("points every vision-enabled tier at its tier-matched mmproj GGUF", () => {
    for (const id of ELIZA_1_VISION_TIER_IDS) {
      const slug = id.slice("eliza-1-".length);
      const entry = MODEL_CATALOG.find((model) => model.id === id);
      expect(entry?.sourceModel?.components.vision?.file).toBe(
        `bundles/${slug}/vision/mmproj-${slug}.gguf`,
      );
    }
  });
});
