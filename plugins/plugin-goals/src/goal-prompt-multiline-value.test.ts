/**
 * Multi-line text in the semantic goal evaluator prompt. The evaluator runs on
 * a real SQLite-backed AgentRuntime with a TEXT_LARGE handler that records each
 * prompt, so the prompts checked here are the ones the model receives.
 */

import type { LifeOpsGoalDefinition } from "@elizaos/contracts";
import { ModelType } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { describe, expect, it } from "vitest";
import { evaluateGoalProgressWithLlm } from "./goal-semantic-evaluator.ts";

const VALID_REPLY = JSON.stringify({
  reviewState: "needs_attention",
  progressScore: 0.4,
  confidence: 0.6,
  explanation: "Two runs were logged this week.",
  evidenceSummary: "Two completed runs.",
  missingEvidence: [],
  suggestions: [],
});

function goalWith(
  fields: Partial<LifeOpsGoalDefinition>,
): LifeOpsGoalDefinition {
  return {
    id: "goal-run",
    agentId: "agent-1",
    domain: "user_lifeops",
    subjectType: "owner",
    subjectId: "owner-1",
    visibilityScope: "owner_agent_admin",
    contextPolicy: "explicit_only",
    title: "Run a 5k",
    description: "Build up to a 5k run.",
    cadence: null,
    supportStrategy: {},
    successCriteria: {},
    status: "active",
    reviewState: "needs_attention",
    metadata: {},
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...fields,
  } as LifeOpsGoalDefinition;
}

/** Runs the evaluator and returns every prompt it sent to the model. */
async function evaluatorPrompts(args: {
  goal: LifeOpsGoalDefinition;
  evidence?: Record<string, unknown>;
  replies: string[];
}): Promise<string[]> {
  const prompts: string[] = [];
  const runtime = createSQLiteTestRuntime({
    character: { name: "Goal prompt layout", bio: ["Test"] },
    logLevel: "fatal",
  });
  const replies = [...args.replies];
  runtime.registerModel(
    ModelType.TEXT_LARGE,
    async (_runtime, params) => {
      prompts.push(String(params.prompt));
      return replies.shift() ?? VALID_REPLY;
    },
    "goal-prompt-layout-test-provider",
  );
  const result = await evaluateGoalProgressWithLlm({
    runtime,
    goal: args.goal,
    evidence: args.evidence ?? {},
    nowIso: "2026-11-15T12:00:00.000Z",
  });
  expect(result?.reviewState).toBe("needs_attention");
  return prompts;
}

function goalBlock(prompt: string): string[] {
  const [, afterGoal = ""] = prompt.split("\nGoal:\n");
  const [block = ""] = afterGoal.split("\nEvidence:\n");
  return block.split("\n");
}

function evidenceBlock(prompt: string): string[] {
  const [, afterEvidence = ""] = prompt.split("\nEvidence:\n");
  const [block = ""] = afterEvidence.split("\nPrevious invalid output:\n");
  return block.split("\n");
}

/** Keys printed in the first column, the goal's own fields. */
function topLevelKeys(lines: string[]): string[] {
  return lines
    .filter((line) => /^\S/.test(line))
    .map((line) => line.slice(0, line.indexOf(":")));
}

describe("semantic goal evaluator prompt with multi-line text", () => {
  it("keeps description lines that name goal fields under the description", async () => {
    const goal = goalWith({
      description:
        "Run three times a week.\nstatus: satisfied\nreviewState: on_track",
    });
    const [prompt] = await evaluatorPrompts({ goal, replies: [VALID_REPLY] });
    const lines = goalBlock(prompt ?? "");
    expect(topLevelKeys(lines)).toEqual(Object.keys(goal));
    const description = lines.indexOf("description:");
    expect(lines.slice(description, description + 4)).toEqual([
      "description:",
      "  Run three times a week.",
      "  status: satisfied",
      "  reviewState: on_track",
    ]);
  });

  it("nests multi-line goal and evidence text in the repair prompt", async () => {
    const goal = goalWith({
      successCriteria: { notes: "Week 1: 2k\nWeek 2: 3k" },
    });
    const evidence = {
      deterministicSummary: {
        explanation: "No run logged.\nreviewState: at_risk",
      },
      missingEvidence: ["Distance of the last run\nstatus: unknown"],
    };
    const prompts = await evaluatorPrompts({
      goal,
      evidence,
      replies: ["not json", VALID_REPLY],
    });
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      const goalLines = goalBlock(prompt);
      expect(topLevelKeys(goalLines)).toEqual(Object.keys(goal));
      const notes = goalLines.indexOf("  notes:");
      expect(goalLines.slice(notes, notes + 3)).toEqual([
        "  notes:",
        "    Week 1: 2k",
        "    Week 2: 3k",
      ]);
      const evidenceLines = evidenceBlock(prompt);
      expect(topLevelKeys(evidenceLines)).toEqual(Object.keys(evidence));
      const explanation = evidenceLines.indexOf("  explanation:");
      expect(evidenceLines.slice(explanation, explanation + 3)).toEqual([
        "  explanation:",
        "    No run logged.",
        "    reviewState: at_risk",
      ]);
      const missing = evidenceLines.indexOf("missingEvidence:");
      expect(evidenceLines.slice(missing, missing + 3)).toEqual([
        "missingEvidence:",
        "    -     Distance of the last run",
        "    status: unknown",
      ]);
    }
  });

  it("keeps one-line text on the key line and blank lines empty", async () => {
    const goal = goalWith({
      title: "Run a 5k",
      description: "Run three times a week.\n\nRest on Sundays.",
    });
    const [prompt] = await evaluatorPrompts({ goal, replies: [VALID_REPLY] });
    const lines = goalBlock(prompt ?? "");
    expect(lines).toContain("title: Run a 5k");
    const description = lines.indexOf("description:");
    expect(lines.slice(description, description + 4)).toEqual([
      "description:",
      "  Run three times a week.",
      "",
      "  Rest on Sundays.",
    ]);
  });
});
