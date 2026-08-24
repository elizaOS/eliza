/**
 * Exercises borrowed-device identity conflicts with deterministic typed
 * evidence, including the explicit user-correction escape hatch.
 */
import { describe, expect, it } from "vitest";
import {
  inferSpeakerName,
  toSpeakerNameAttribution,
} from "./speaker-name-inference.ts";

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

describe("inferSpeakerName guardrails and ambiguity handling", () => {
  it("withholds resolution when sensitiveAttributeGuardrail is enabled", () => {
    const result = inferSpeakerName({
      speakerId: "speaker-1",
      sensitiveAttributeGuardrail: true,
      evidence: [
        {
          source: "voice_profile",
          confidence: 0.99,
          name: "Confident Speaker",
        },
      ],
    });

    expect(result.resolution).toBe("withheld");
    expect(result.reasonCodes).toContain("sensitive_attribute_guardrail");
    expect(result.bindingPlan.action).toBe("none");
  });

  it("withholds when two candidates share the same first name with high confidence", () => {
    const result = inferSpeakerName({
      speakerId: "speaker-1",
      evidence: [
        {
          source: "calendar_attendee",
          confidence: 0.8,
          name: "Alex Smith",
        },
        {
          source: "platform_roster",
          confidence: 0.75,
          name: "Alex Jones",
        },
      ],
    });

    expect(result.resolution).toBe("withheld");
    expect(result.reasonCodes).toContain("same_first_name_ambiguity");
  });

  it("marks as needs_confirmation when conflicting names have close confidence", () => {
    const result = inferSpeakerName({
      speakerId: "speaker-1",
      evidence: [
        {
          source: "calendar_attendee",
          confidence: 0.85,
          name: "Alice Baker",
        },
        {
          source: "platform_roster",
          confidence: 0.82,
          name: "Charlie Davis",
        },
      ],
    });

    expect(result.resolution).toBe("needs_confirmation");
    expect(result.reasonCodes).toContain("conflicting_name_evidence");
  });

  it("returns unknown when no name evidence is supplied", () => {
    const result = inferSpeakerName({
      speakerId: "speaker-1",
      evidence: [],
    });

    expect(result.resolution).toBe("unknown");
    expect(result.reasonCodes).toContain("no_name_evidence");
    expect(result.requiresReview).toBe(true);
  });
});

describe("inferSpeakerName entity binding and attribution conversion", () => {
  it("generates merge_duplicate_entities plan when multiple existing entities match", () => {
    const result = inferSpeakerName({
      speakerId: "speaker-1",
      evidence: [
        {
          source: "voice_profile",
          confidence: 0.95,
          name: "Alice Cooper",
        },
      ],
      existingEntities: [
        { entityId: "ent-1", displayName: "Alice Cooper" },
        { entityId: "ent-2", displayName: "alice cooper" },
      ],
    });

    expect(result.resolution).toBe("confirmed");
    expect(result.bindingPlan.action).toBe("merge_duplicate_entities");
    expect(result.bindingPlan.mergeEntityIds).toEqual(["ent-1", "ent-2"]);
    expect(result.bindingPlan.reasonCodes).toContain(
      "duplicate_entity_merge_required",
    );
    expect(result.requiresReview).toBe(true);
  });

  it("converts inference to transport-safe speaker attribution", () => {
    const result = inferSpeakerName({
      speakerId: "speaker-1",
      evidence: [
        {
          source: "voice_profile",
          confidence: 0.95,
          name: "Alice Cooper",
        },
      ],
    });

    const attribution = toSpeakerNameAttribution(result);
    expect(attribution.resolution).toBe("confirmed");
    expect(attribution.displayName).toBe("Alice Cooper");
    expect(attribution.confidence).toBe(0.95);
    expect("bindingPlan" in attribution).toBe(false);
  });
});
