/**
 * Tests for speaker-name inference engine and attribution mapping.
 */
import { describe, expect, it } from "vitest";
import {
  type InferSpeakerNameInput,
  inferSpeakerName,
  toSpeakerNameAttribution,
} from "./speaker-name-inference.ts";

describe("inferSpeakerName", () => {
  it("returns unknown resolution when no evidence is provided", () => {
    const result = inferSpeakerName({
      speakerId: "spk-1",
      evidence: [],
    });

    expect(result.speakerId).toBe("spk-1");
    expect(result.resolution).toBe("unknown");
    expect(result.confidence).toBe(0);
    expect(result.reasonCodes).toContain("no_name_evidence");
    expect(result.requiresReview).toBe(true);
    expect(result.bindingPlan.action).toBe("none");
  });

  it("confirms identity from high-confidence user correction and creates entity", () => {
    const input: InferSpeakerNameInput = {
      speakerId: "spk-1",
      evidence: [
        {
          source: "user_correction",
          confidence: 0.95,
          name: "Alice Johnson",
        },
      ],
    };

    const result = inferSpeakerName(input);
    expect(result.resolution).toBe("confirmed");
    expect(result.displayName).toBe("Alice Johnson");
    expect(result.reasonCodes).toContain("user_correction_applied");
    expect(result.reasonCodes).toContain("high_confidence_name");
    expect(result.bindingPlan.action).toBe("create_entity");
    expect(result.bindingPlan.displayName).toBe("Alice Johnson");
  });

  it("binds existing entity when single matching entity is found", () => {
    const input: InferSpeakerNameInput = {
      speakerId: "spk-2",
      evidence: [
        {
          source: "voice_profile",
          confidence: 0.92,
          name: "Bob Smith",
          profileId: "vp-bob",
        },
      ],
      existingEntities: [
        {
          entityId: "ent-bob-1",
          displayName: "Bob Smith",
        },
      ],
    };

    const result = inferSpeakerName(input);
    expect(result.resolution).toBe("confirmed");
    expect(result.displayName).toBe("Bob Smith");
    expect(result.entityId).toBe("ent-bob-1");
    expect(result.profileId).toBe("vp-bob");
    expect(result.bindingPlan.action).toBe("bind_existing_entity");
    expect(result.bindingPlan.entityId).toBe("ent-bob-1");
  });

  it("plans entity merge when multiple existing entities share normalized name", () => {
    const input: InferSpeakerNameInput = {
      speakerId: "spk-3",
      evidence: [
        {
          source: "voice_profile",
          confidence: 0.9,
          name: "Charlie Brown",
        },
      ],
      existingEntities: [
        { entityId: "ent-cb-1", displayName: "Charlie Brown" },
        { entityId: "ent-cb-2", displayName: "charlie brown" },
      ],
    };

    const result = inferSpeakerName(input);
    expect(result.resolution).toBe("confirmed");
    expect(result.bindingPlan.action).toBe("merge_duplicate_entities");
    expect(result.bindingPlan.mergeEntityIds).toEqual(["ent-cb-1", "ent-cb-2"]);
    expect(result.bindingPlan.reasonCodes).toContain(
      "duplicate_entity_merge_required",
    );
    expect(result.requiresReview).toBe(true);
  });

  it("withholds identity when borrowed device conflict is detected", () => {
    const input: InferSpeakerNameInput = {
      speakerId: "spk-4",
      evidence: [
        {
          source: "platform_roster",
          confidence: 0.74,
          name: "Dave's Laptop",
        },
        {
          source: "self_introduction",
          confidence: 0.88,
          name: "Eve Adams",
        },
      ],
    };

    const result = inferSpeakerName(input);
    expect(result.resolution).toBe("withheld");
    expect(result.reasonCodes).toContain("borrowed_device_guardrail");
  });

  it("withholds identity when same first name ambiguity exists", () => {
    const input: InferSpeakerNameInput = {
      speakerId: "spk-5",
      evidence: [
        { source: "calendar_attendee", confidence: 0.7, name: "John Doe" },
        { source: "platform_roster", confidence: 0.74, name: "John Smith" },
      ],
    };

    const result = inferSpeakerName(input);
    expect(result.resolution).toBe("withheld");
    expect(result.reasonCodes).toContain("same_first_name_ambiguity");
  });

  it("withholds identity when sensitiveAttributeGuardrail is enabled", () => {
    const input: InferSpeakerNameInput = {
      speakerId: "spk-6",
      evidence: [
        { source: "voice_profile", confidence: 0.95, name: "Grace Hopper" },
      ],
      sensitiveAttributeGuardrail: true,
    };

    const result = inferSpeakerName(input);
    expect(result.resolution).toBe("withheld");
    expect(result.reasonCodes).toContain("sensitive_attribute_guardrail");
  });

  it("throws for invalid confidence ratio values", () => {
    expect(() =>
      inferSpeakerName({
        speakerId: "spk-7",
        evidence: [
          { source: "platform_roster", confidence: 1.5, name: "Invalid" },
        ],
      }),
    ).toThrow(/must be between 0 and 1/);
  });
});

describe("toSpeakerNameAttribution", () => {
  it("converts inference to attribution by stripping mutation plans", () => {
    const inference = inferSpeakerName({
      speakerId: "spk-1",
      evidence: [
        {
          source: "user_correction",
          confidence: 0.95,
          name: "Alice",
        },
      ],
    });

    const attribution = toSpeakerNameAttribution(inference);
    expect(attribution.resolution).toBe("confirmed");
    expect(attribution.displayName).toBe("Alice");
    expect(attribution.confidence).toBe(0.95);
    expect("bindingPlan" in attribution).toBe(false);
    expect("voiceTurnBindingPlan" in attribution).toBe(false);
  });

  it("handles nullish inference safely", () => {
    const attribution = toSpeakerNameAttribution(null);
    expect(attribution.resolution).toBe("unknown");
    expect(attribution.confidence).toBe(0);
  });
});
