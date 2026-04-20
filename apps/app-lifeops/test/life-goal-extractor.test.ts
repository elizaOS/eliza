import type { AgentRuntime } from "@elizaos/core";
import type { LifeOpsGoalDefinition } from "@elizaos/shared/contracts/lifeops";
import { describe, expect, it } from "vitest";
import {
  buildGoalCreateExtractionPrompt,
  buildGoalUpdateExtractionPrompt,
  extractGoalCreatePlanWithLlm,
  extractGoalUpdatePlanWithLlm,
  mergeGoalMetadataWithGrounding,
  planToGoalGroundingMetadata,
} from "../src/actions/life-goal-extractor.js";

function makeGoalDefinition(): LifeOpsGoalDefinition {
  return {
    id: "goal-1",
    agentId: "agent-1",
    domain: "user_lifeops",
    subjectType: "owner",
    subjectId: "owner-1",
    visibilityScope: "owner_only",
    contextPolicy: "allowed_in_private_chat",
    title: "Stabilize sleep schedule",
    description: "Keep sleep and wake times consistent.",
    cadence: { kind: "weekly" },
    supportStrategy: {},
    successCriteria: {},
    status: "active",
    reviewState: "idle",
    metadata: {},
    createdAt: "2026-04-12T00:00:00.000Z",
    updatedAt: "2026-04-12T00:00:00.000Z",
  };
}

describe("life-goal-extractor", () => {
  it("includes grounding instructions in the create prompt", () => {
    const prompt = buildGoalCreateExtractionPrompt(
      "I want a goal called Stabilize sleep schedule.",
      "user: I want a goal called Stabilize sleep schedule.",
    );

    expect(prompt).toContain("A goal is only ready to save");
    expect(prompt).toContain('"mode":"respond"');
    expect(prompt).toContain("successCriteria");
    expect(prompt).toContain("supportStrategy");
  });

  it("includes current goal context in the update prompt", () => {
    const prompt = buildGoalUpdateExtractionPrompt({
      currentGoal: makeGoalDefinition(),
      intent: "Make the goal weekly instead of monthly.",
      recentConversation:
        "user: Make the goal weekly instead of monthly.\nassistant: Sure.",
    });

    expect(prompt).toContain("Current goal title");
    expect(prompt).toContain("Current success criteria");
    expect(prompt).toContain("Make the goal weekly instead of monthly.");
  });

  it("returns a structured clarification plan when no model is available for create", async () => {
    const plan = await extractGoalCreatePlanWithLlm({
      runtime: {} as AgentRuntime,
      intent: "I want a goal called Stabilize sleep schedule.",
      state: undefined,
    });

    expect(plan.mode).toBe("respond");
    expect(plan.groundingState).toBe("ungrounded");
    expect(plan.title).toBeNull();
    expect(plan.response).toBeTruthy();
    expect(plan.missingCriticalFields.length).toBeGreaterThan(0);
  });

  it("normalizes title-bearing clarification plans to partial grounding", async () => {
    const plan = await extractGoalCreatePlanWithLlm({
      runtime: {
        useModel: async () =>
          JSON.stringify({
            mode: "respond",
            response: "What would a stabilized sleep schedule look like for you?",
            title: "Stabilize sleep schedule",
            description: "Build a more consistent sleep schedule.",
            cadence: { kind: "weekly" },
            successCriteria: null,
            supportStrategy: null,
            groundingState: "ungrounded",
            missingCriticalFields: ["title"],
            confidence: 0.62,
            evaluationSummary: null,
            targetDomain: "sleep",
          }),
      } as AgentRuntime,
      intent: "I want a goal called Stabilize sleep schedule.",
      state: undefined,
    });

    expect(plan.mode).toBe("respond");
    expect(plan.groundingState).toBe("partial");
    expect(plan.title).toBe("Stabilize sleep schedule");
    expect(plan.missingCriticalFields).toEqual([
      "target_state",
      "success_metric",
      "time_horizon",
      "evidence_source",
      "support_plan",
    ]);
  });

  it("does not upgrade an ungrounded plan from model-only title text", async () => {
    const plan = await extractGoalCreatePlanWithLlm({
      runtime: {
        useModel: async () =>
          JSON.stringify({
            mode: "respond",
            response: "What goal do you want to work on?",
            title: "Run a marathon",
            description: "Build a better routine.",
            cadence: null,
            successCriteria: null,
            supportStrategy: null,
            groundingState: "ungrounded",
            missingCriticalFields: ["title", "target_state"],
            confidence: 0.52,
            evaluationSummary: null,
            targetDomain: "fitness",
          }),
      } as AgentRuntime,
      intent: "Can you help me make a goal?",
      state: undefined,
    });

    expect(plan.mode).toBe("respond");
    expect(plan.groundingState).toBe("ungrounded");
    expect(plan.title).toBe("Run a marathon");
    expect(plan.missingCriticalFields).toEqual(["title", "target_state"]);
  });

  it("returns a structured clarification plan when no model is available for update", async () => {
    const plan = await extractGoalUpdatePlanWithLlm({
      runtime: {} as AgentRuntime,
      currentGoal: makeGoalDefinition(),
      intent: "Tighten the sleep window.",
      state: undefined,
    });

    expect(plan.mode).toBe("respond");
    expect(plan.response).toBeTruthy();
    expect(plan.title).toBeNull();
    expect(plan.groundingState).toBeNull();
  });

  it("converts a grounded plan into persisted goal metadata", () => {
    const metadata = planToGoalGroundingMetadata(
      {
        cadence: { kind: "weekly" },
        confidence: 0.91,
        evaluationSummary:
          "Progress means weekday bed and wake times stay near the target window for the next month.",
        groundingState: "grounded",
        missingCriticalFields: [],
        successCriteria: {
          evidenceSignals: ["health.sleep", "manual_checkin", "health.sleep"],
        },
        targetDomain: "sleep",
      },
      "2026-04-12T12:00:00.000Z",
    );

    expect(metadata.groundingState).toBe("grounded");
    expect(metadata.targetDomain).toBe("sleep");
    expect(metadata.summary).toContain("Progress means");
    expect(metadata.reviewCadenceKind).toBe("weekly");
    expect(metadata.evidenceSignals).toEqual([
      "health.sleep",
      "manual_checkin",
    ]);
  });

  it("merges grounding metadata without dropping existing metadata keys", () => {
    const merged = mergeGoalMetadataWithGrounding({
      metadata: {
        source: "chat",
        originalIntent: "I want to stabilize my sleep schedule.",
      },
      nowIso: "2026-04-12T12:00:00.000Z",
      plan: {
        cadence: { kind: "weekly" },
        confidence: 0.88,
        evaluationSummary: "Weekly progress is judged by sleep consistency.",
        groundingState: "grounded",
        missingCriticalFields: [],
        successCriteria: {
          evidenceSignals: ["health.sleep"],
        },
        targetDomain: "sleep",
      },
    });

    expect(merged.source).toBe("chat");
    expect(merged.originalIntent).toBe(
      "I want to stabilize my sleep schedule.",
    );
    expect(merged.goalGrounding).toMatchObject({
      groundingState: "grounded",
      targetDomain: "sleep",
      reviewCadenceKind: "weekly",
    });
  });
});
