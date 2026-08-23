/**
 * Exercises borrowed-device identity conflicts with deterministic typed
 * evidence, including the explicit user-correction escape hatch.
 */
import { describe, expect, it } from "vitest";
import { inferSpeakerName } from "./speaker-name-inference.ts";

describe("inferSpeakerName borrowed-device precedence", () => {
  it("withholds automatic identity evidence that conflicts with the device roster", () => {
    const result = inferSpeakerName({
      speakerId: "speaker-1",
      evidence: [
        {
          source: "platform_roster",
          confidence: 0.74,
          name: "Device Owner",
        },
        {
          source: "voice_profile",
          confidence: 0.99,
          name: "Guest Speaker",
          profileId: "voice-guest",
        },
      ],
    });

    expect(result.resolution).toBe("withheld");
    expect(result.reasonCodes).toContain("borrowed_device_guardrail");
    expect(result.bindingPlan.action).toBe("none");
  });

  it("lets an explicit user correction resolve a borrowed-device conflict", () => {
    const result = inferSpeakerName({
      speakerId: "speaker-1",
      evidence: [
        {
          source: "platform_roster",
          confidence: 0.74,
          name: "Device Owner",
        },
        {
          source: "user_correction",
          confidence: 0.99,
          name: "Actual Speaker",
        },
      ],
    });

    expect(result.resolution).toBe("confirmed");
    expect(result.displayName).toBe("Actual Speaker");
    expect(result.reasonCodes).toContain("user_correction_applied");
    expect(result.bindingPlan.action).toBe("create_entity");
  });

  it("sorts equal-score candidates deterministically by normalized name", () => {
    const result = inferSpeakerName({
      speakerId: "speaker-1",
      evidence: [
        { source: "platform_roster", confidence: 0.8, name: "B Speaker" },
        { source: "platform_roster", confidence: 0.8, name: "A Speaker" },
        { source: "platform_roster", confidence: 0.9, name: "C Speaker" },
      ],
    });

    expect(result.candidateNames.map((candidate) => candidate.name)).toEqual([
      "C Speaker",
      "A Speaker",
      "B Speaker",
    ]);
  });
});
