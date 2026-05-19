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
  it("has 6 steps in the canonical order", () => {
    expect(VOICE_PREFIX_STEPS).toEqual([
      "welcome",
      "tier",
      "user-speaks",
      "owner-confirm",
      "family",
      "agent-speaks",
    ]);
  });

  it("provides meta for every step", () => {
    for (const id of VOICE_PREFIX_STEPS) {
      expect(VOICE_PREFIX_STEP_META[id]).toBeDefined();
      expect(VOICE_PREFIX_STEP_META[id]?.id).toBe(id);
    }
  });

  it("only marks family as optional", () => {
    expect(VOICE_PREFIX_STEP_META.family.optional).toBe(true);
    expect(VOICE_PREFIX_STEP_META.welcome.optional).toBe(false);
    expect(VOICE_PREFIX_STEP_META["owner-confirm"].optional).toBe(false);
  });
});

describe("resolveVoicePrefixSteps", () => {
  it("returns the full 6-step list for every tier", () => {
    expect(resolveVoicePrefixSteps("MAX")).toHaveLength(6);
    expect(resolveVoicePrefixSteps("GOOD")).toHaveLength(6);
    expect(resolveVoicePrefixSteps("OKAY")).toHaveLength(6);
    expect(resolveVoicePrefixSteps("POOR")).toHaveLength(6);
    expect(resolveVoicePrefixSteps(null)).toHaveLength(6);
  });
});

describe("nextVoicePrefixStep / previousVoicePrefixStep", () => {
  it("walks forward through the 6-step list", () => {
    expect(nextVoicePrefixStep("welcome", "GOOD")).toBe("tier");
    expect(nextVoicePrefixStep("tier", "GOOD")).toBe("user-speaks");
    expect(nextVoicePrefixStep("family", "GOOD")).toBe("agent-speaks");
    expect(nextVoicePrefixStep("agent-speaks", "GOOD")).toBeNull();
  });

  it("walks backward through the list", () => {
    expect(previousVoicePrefixStep("welcome", "GOOD")).toBeNull();
    expect(previousVoicePrefixStep("tier", "GOOD")).toBe("welcome");
    expect(previousVoicePrefixStep("user-speaks", "GOOD")).toBe("tier");
    expect(previousVoicePrefixStep("agent-speaks", "GOOD")).toBe("family");
  });

  it("voicePrefixIsComplete returns true only at the last step", () => {
    expect(voicePrefixIsComplete("agent-speaks", "GOOD")).toBe(true);
    expect(voicePrefixIsComplete("family", "GOOD")).toBe(false);
    expect(voicePrefixIsComplete("owner-confirm", "GOOD")).toBe(false);
    expect(voicePrefixIsComplete("agent-speaks", "POOR")).toBe(true);
  });
});
