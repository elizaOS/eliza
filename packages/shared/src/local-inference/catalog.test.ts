import { describe, expect, it } from "vitest";
import {
  ELIZA_1_HOSTED_MTP_TIER_IDS,
  ELIZA_1_MTP_TIER_IDS,
  ELIZA_1_ON_DEVICE_TIER_IDS,
  ELIZA_1_TIER_IDS,
  ELIZA_1_VISION_TIER_IDS,
  isOnDeviceTier,
  MODEL_CATALOG,
} from "./catalog.js";

const EXPECTED_DISPLAY_NAMES: Record<string, string> = {
  "eliza-1-2b": "eliza-1-2B",
  "eliza-1-4b": "eliza-1-4B",
  "eliza-1-9b": "eliza-1-9B",
  "eliza-1-27b": "eliza-1-27B",
  "eliza-1-27b-256k": "eliza-1-27B-256k",
};
const EXPECTED_CHAT_PARAMS: Record<string, string> = {
  "eliza-1-2b": "2B",
  "eliza-1-4b": "4B",
  "eliza-1-9b": "9B",
  "eliza-1-27b": "27B",
  "eliza-1-27b-256k": "27B",
};

describe("Eliza-1 runtime quant metadata", () => {
  it("keeps stable ids but exposes requested size-cased display names", () => {
    for (const id of ELIZA_1_TIER_IDS) {
      const entry = MODEL_CATALOG.find((model) => model.id === id);
      expect(entry?.displayName).toBe(EXPECTED_DISPLAY_NAMES[id]);
      expect(entry?.params).toBe(EXPECTED_CHAT_PARAMS[id]);
      expect(entry?.ggufFile).toContain(id);
    }
  });

  it("ships every active text tier at or above the 128k floor", () => {
    for (const id of ELIZA_1_TIER_IDS) {
      const entry = MODEL_CATALOG.find((model) => model.id === id);
      expect(entry?.contextLength).toBeGreaterThanOrEqual(131072);
      expect(entry?.ggufFile).not.toMatch(/-(32k|64k)\.gguf$/);
      if (id === "eliza-1-27b-256k") {
        expect(entry?.contextLength).toBe(262144);
        expect(entry?.ggufFile).toBe("text/eliza-1-27b-256k.gguf");
      } else {
        expect(entry?.contextLength).toBe(131072);
        expect(entry?.ggufFile).toBe(`text/${id}-128k.gguf`);
      }
    }
  });

  it("advertises only safe runtime optimizations for the shipped gemma4 tiers", () => {
    const hostedMtpTiers: ReadonlySet<string> = new Set(
      ELIZA_1_HOSTED_MTP_TIER_IDS,
    );
    for (const id of ELIZA_1_TIER_IDS) {
      const entry = MODEL_CATALOG.find((model) => model.id === id);
      expect(entry?.runtime?.kvCache).toBeUndefined();
      expect(entry?.runtime?.optimizations?.requiresKernel).toContain("turbo3");
      expect(entry?.runtime?.optimizations?.requiresKernel).toContain("turbo4");
      expect(entry?.runtime?.optimizations?.requiresKernel).not.toContain(
        "qjl_full",
      );
      expect(entry?.runtime?.optimizations?.requiresKernel).not.toContain(
        "polarquant",
      );
      // Gemma-aware RAM defaults (#9033 / llama.cpp#21690): the Gemma-4 KV
      // context-checkpoint ring is bounded to 1 and decode is single-slot
      // (-np 1) so server KV cannot grow unbounded on the single-user
      // on-device runtime.
      expect(entry?.runtime?.optimizations?.ctxCheckpoints).toBe(1);
      expect(entry?.runtime?.optimizations?.parallel).toBe(1);
      if (hostedMtpTiers.has(id)) {
        expect(entry?.runtime?.mtp?.specType).toBe("draft-mtp");
      } else {
        expect(entry?.runtime?.mtp).toBeUndefined();
      }
    }
  });

  it("advertises Gemma MTP metadata only for tiers with hosted drafter GGUFs", () => {
    expect(ELIZA_1_MTP_TIER_IDS).toEqual(ELIZA_1_TIER_IDS);
    // 2b/4b host the gemma4-assistant drafters at
    // bundles/<tier>/mtp/drafter-<tier>.gguf (converted from
    // google/gemma-4-E2B-it-assistant / google/gemma-4-E4B-it-assistant,
    // 2026-07-02).
    expect(ELIZA_1_HOSTED_MTP_TIER_IDS).toEqual(["eliza-1-2b", "eliza-1-4b"]);
    const hosted: ReadonlySet<string> = new Set(ELIZA_1_HOSTED_MTP_TIER_IDS);
    for (const id of ELIZA_1_MTP_TIER_IDS) {
      const entry = MODEL_CATALOG.find((model) => model.id === id);
      const slug = id.slice("eliza-1-".length);
      if (hosted.has(id)) {
        expect(entry?.runtime?.mtp?.specType).toBe("draft-mtp");
        expect(entry?.runtime?.mtp?.drafterFile).toBe(
          `mtp/drafter-${slug}.gguf`,
        );
        expect(entry?.runtime?.mtp?.draftMax).toBe(1);
        expect(entry?.sourceModel?.components.mtp?.file).toBe(
          `bundles/${slug}/mtp/drafter-${slug}.gguf`,
        );
      } else {
        expect(entry?.runtime?.mtp).toBeUndefined();
        expect(entry?.sourceModel?.components.mtp).toBeUndefined();
      }
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

  it("points every voice-enabled tier at its tier-matched ASR mmproj GGUF", () => {
    for (const id of ELIZA_1_TIER_IDS) {
      const slug = id.slice("eliza-1-".length);
      const entry = MODEL_CATALOG.find((model) => model.id === id);
      expect(entry?.sourceModel?.components.asr?.file).toBe(
        `bundles/${slug}/asr/mmproj-audio-${slug}-bf16.gguf`,
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

  it("gates the on-device tier set to exactly 2b/4b", () => {
    // The mobile QAT/LiteRT bundle is only valid for phone-class tiers; if this
    // set ever widens the .litertlm/wna8o8 advertisement leaks onto desktop
    // tiers, and isOnDeviceTier must agree with the exported id list exactly.
    expect(ELIZA_1_ON_DEVICE_TIER_IDS).toEqual(["eliza-1-2b", "eliza-1-4b"]);
    for (const id of ELIZA_1_TIER_IDS) {
      const expected = id === "eliza-1-2b" || id === "eliza-1-4b";
      expect(isOnDeviceTier(id)).toBe(expected);
    }
    for (const id of [
      "eliza-1-9b",
      "eliza-1-27b",
      "eliza-1-27b-256k",
    ] as const) {
      expect(isOnDeviceTier(id)).toBe(false);
    }
  });

  it("advertises the mobile QAT Q4_0 + LiteRT-LM bundle on every on-device tier", () => {
    for (const id of ELIZA_1_ON_DEVICE_TIER_IDS) {
      const entry = MODEL_CATALOG.find((model) => model.id === id);
      const variants = entry?.quantization?.variants ?? [];

      const q4_0 = variants.find((variant) => variant.id === "q4_0");
      expect(q4_0?.mobilePreferred).toBe(true);

      // The LiteRT-LM / NPU mobile bundle is a `.litertlm` artifact, not GGUF.
      const litert = variants.find((variant) => variant.id === "wna8o8");
      expect(litert?.artifactFormat).toBe("litertlm");
      expect(litert?.ggufFile).toMatch(/\.litertlm$/);
    }
  });

  it("never advertises the mobile QAT/LiteRT bundle on desktop tiers", () => {
    const desktopTiers = ELIZA_1_TIER_IDS.filter((id) => !isOnDeviceTier(id));
    expect(desktopTiers).toEqual([
      "eliza-1-9b",
      "eliza-1-27b",
      "eliza-1-27b-256k",
    ]);
    for (const id of desktopTiers) {
      const entry = MODEL_CATALOG.find((model) => model.id === id);
      const variants = entry?.quantization?.variants ?? [];

      // No variant may carry the mobile-preferred flag or the LiteRT bundle
      // format on a desktop tier — that would advertise the phone-only QAT
      // artifact on hardware that runs the post-training GGUF instead.
      for (const variant of variants) {
        expect(variant.mobilePreferred).toBeUndefined();
        expect(variant.artifactFormat).not.toBe("litertlm");
      }
      expect(variants.some((variant) => variant.id === "wna8o8")).toBe(false);

      // The shared Q4_0 GGUF variant is present on every tier, but stays
      // un-flagged on desktop so the on-device selector never picks it.
      const q4_0 = variants.find((variant) => variant.id === "q4_0");
      expect(q4_0?.mobilePreferred).toBeUndefined();
    }
  });
});
