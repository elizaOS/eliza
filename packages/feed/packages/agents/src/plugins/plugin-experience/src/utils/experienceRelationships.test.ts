import { describe, expect, test } from "bun:test";
import type { UUID } from "@elizaos/core";
import { type Experience, ExperienceType, OutcomeType } from "../types";
import { ExperienceRelationshipManager } from "./experienceRelationships";

function makeExperience(
  id: string,
  overrides: Partial<Experience> = {},
): Experience {
  return {
    id: id as UUID,
    agentId: "00000000-0000-0000-0000-000000000001" as UUID,
    type: ExperienceType.SUCCESS,
    outcome: OutcomeType.POSITIVE,
    context: "deploying a service",
    action: "deploy",
    result: "deployment completed",
    learning: "deployment signal",
    tags: [],
    domain: "shell",
    confidence: 0.9,
    importance: 0.5,
    createdAt: 1,
    updatedAt: 1,
    accessCount: 0,
    ...overrides,
  };
}

describe("ExperienceRelationshipManager.findContradictions", () => {
  test("returns a matching experience once when both detection paths match", () => {
    const manager = new ExperienceRelationshipManager();
    const source = makeExperience("source");
    const target = makeExperience("target", {
      outcome: OutcomeType.NEGATIVE,
      result: "deployment failed",
    });

    manager.addRelationship({
      fromId: source.id,
      toId: target.id,
      type: "contradicts",
      strength: 1,
    });

    expect(manager.findContradictions(source, [source, target])).toEqual([
      target,
    ]);
  });

  test("keeps action/outcome and explicit relationship detection independently", () => {
    const manager = new ExperienceRelationshipManager();
    const source = makeExperience("source");
    const outcomeMatch = makeExperience("outcome-match", {
      outcome: OutcomeType.NEGATIVE,
    });
    const explicitMatch = makeExperience("explicit-match", {
      action: "inspect",
      outcome: OutcomeType.POSITIVE,
    });

    manager.addRelationship({
      fromId: source.id,
      toId: explicitMatch.id,
      type: "contradicts",
      strength: 0.7,
    });

    expect(
      manager.findContradictions(source, [source, outcomeMatch, explicitMatch]),
    ).toEqual([outcomeMatch, explicitMatch]);
  });
});
