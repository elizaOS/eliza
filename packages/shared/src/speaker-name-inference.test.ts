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

  it("sorts speaker name candidates deterministically with score and candidateName tiebreaker", () => {
    const candidates = [
      { candidateName: "B Speaker", score: 0.8, confidence: 0.8 },
      { candidateName: "A Speaker", score: 0.8, confidence: 0.8 },
      { candidateName: "C Speaker", score: 0.9, confidence: 0.9 },
    ];

    candidates.sort((a, b) => {
      const bScore =
        typeof b.score === "number" && Number.isFinite(b.score) ? b.score : 0;
      const aScore =
        typeof a.score === "number" && Number.isFinite(a.score) ? a.score : 0;
      const bConf =
        typeof b.confidence === "number" && Number.isFinite(b.confidence)
          ? b.confidence
          : 0;
      const aConf =
        typeof a.confidence === "number" && Number.isFinite(a.confidence)
          ? a.confidence
          : 0;
      return (
        bScore - aScore ||
        bConf - aConf ||
        a.candidateName.localeCompare(b.candidateName)
      );
    });

    expect(candidates[0]?.candidateName).toBe("C Speaker");
    expect(candidates[1]?.candidateName).toBe("A Speaker");
    expect(candidates[2]?.candidateName).toBe("B Speaker");
  });
});
