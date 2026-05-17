import { describe, expect, it } from "vitest";

import {
  nextVoicePrefixStep,
  previousVoicePrefixStep,
  resolveVoicePrefixSteps,
  VOICE_PREFIX_STEP_META,
  VOICE_PREFIX_STEPS,
  voicePrefixIsComplete,
} from "./voice-prefix";

describe("voice-prefix step graph", () => {
  it("has 7 steps in the canonical order", () => {
    expect(VOICE_PREFIX_STEPS).toEqual([
      "welcome",
      "tier",
      "models",
      "agent-speaks",
      "user-speaks",
      "owner-confirm",
      "family",
    ]);
  });

  it("provides meta for every step", () => {
    for (const id of VOICE_PREFIX_STEPS) {
      expect(VOICE_PREFIX_STEP_META[id]).toBeDefined();
      expect(VOICE_PREFIX_STEP_META[id]?.id).toBe(id);
    }
  });

  it("only marks family + models as optional", () => {
    expect(VOICE_PREFIX_STEP_META.family.optional).toBe(true);
    expect(VOICE_PREFIX_STEP_META.models.optional).toBe(true);
    expect(VOICE_PREFIX_STEP_META.welcome.optional).toBe(false);
    expect(VOICE_PREFIX_STEP_META["owner-confirm"].optional).toBe(false);
  });
});

describe("resolveVoicePrefixSteps", () => {
  it("returns the full 7-step list for MAX/GOOD/OKAY tiers", () => {
    expect(resolveVoicePrefixSteps("MAX")).toHaveLength(7);
    expect(resolveVoicePrefixSteps("GOOD")).toHaveLength(7);
    expect(resolveVoicePrefixSteps("OKAY")).toHaveLength(7);
    expect(resolveVoicePrefixSteps(null)).toHaveLength(7);
  });

  it("skips the models step on POOR tier", () => {
    const steps = resolveVoicePrefixSteps("POOR");
    expect(steps).toHaveLength(6);
    expect(steps).not.toContain("models");
  });
});

describe("nextVoicePrefixStep / previousVoicePrefixStep", () => {
  it("walks forward through the 7-step list", () => {
    expect(nextVoicePrefixStep("welcome", "GOOD")).toBe("tier");
    expect(nextVoicePrefixStep("tier", "GOOD")).toBe("models");
    expect(nextVoicePrefixStep("models", "GOOD")).toBe("agent-speaks");
    expect(nextVoicePrefixStep("family", "GOOD")).toBeNull();
  });

  it("walks backward through the list", () => {
    expect(previousVoicePrefixStep("welcome", "GOOD")).toBeNull();
    expect(previousVoicePrefixStep("tier", "GOOD")).toBe("welcome");
    expect(previousVoicePrefixStep("models", "GOOD")).toBe("tier");
  });

  it("skips models when POOR tier", () => {
    expect(nextVoicePrefixStep("tier", "POOR")).toBe("agent-speaks");
    expect(previousVoicePrefixStep("agent-speaks", "POOR")).toBe("tier");
  });

  it("voicePrefixIsComplete returns true only at the last step", () => {
    expect(voicePrefixIsComplete("family", "GOOD")).toBe(true);
    expect(voicePrefixIsComplete("owner-confirm", "GOOD")).toBe(false);
    expect(voicePrefixIsComplete("family", "POOR")).toBe(true);
  });
});
