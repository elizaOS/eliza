/**
 * Unit tests for character hub helpers: validates experience record mapping.
 */
import { describe, expect, it } from "vitest";
import type { ExperienceRecord } from "../../api";
import { mapExperienceRecordToHubRecord } from "./character-hub-helpers.ts";

describe("character-hub-helpers", () => {
  it("maps ExperienceRecord fields onto CharacterExperienceRecord structure", () => {
    const raw: ExperienceRecord = {
      id: "exp-1",
      type: "learning",
      outcome: "success",
      context: "coding task",
      action: "run_build",
      result: "build succeeded",
      learning: "always run build first",
      tags: ["code"],
      keywords: ["build"],
      associatedEntityIds: ["user-1"],
      domain: "engineering",
      confidence: 0.95,
      importance: 0.8,
      createdAt: "2026-08-24T00:00:00Z",
      updatedAt: "2026-08-24T00:00:00Z",
      supersedes: null,
      relatedExperiences: ["exp-0"],
      mergedExperienceIds: [],
      embeddingDimensions: 1536,
      previousBelief: null,
      correctedBelief: null,
      sourceMessageIds: ["m-1"],
      sourceRoomId: "r-1",
      sourceTriggerMessageId: "m-1",
      sourceTrajectoryId: null,
      sourceTrajectoryStepId: null,
      extractionMethod: "llm",
      extractionReason: "user taught new rule",
    };

    const mapped = mapExperienceRecordToHubRecord(raw);
    expect(mapped.id).toBe("exp-1");
    expect(mapped.relatedExperienceIds).toEqual(["exp-0"]);
    expect(mapped.learning).toBe("always run build first");
    expect(mapped.confidence).toBe(0.95);
  });
});
