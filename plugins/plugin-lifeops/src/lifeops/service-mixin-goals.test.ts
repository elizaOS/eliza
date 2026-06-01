import { describe, expect, it } from "vitest";
import type { LifeOpsGoalDefinition } from "../contracts/index.js";
import { buildLifeOpsGoalWorkstreamTaskInput } from "./goal-workstream.js";

function goal(
  overrides: Partial<LifeOpsGoalDefinition> = {},
): LifeOpsGoalDefinition {
  return {
    id: "goal-1",
    agentId: "agent-1",
    domain: "user_lifeops",
    subjectType: "owner",
    subjectId: "owner-1",
    visibilityScope: "owner_only",
    contextPolicy: "explicit_only",
    title: "ship useful upstream PRs",
    description: "Keep the elizaOS work moving.",
    cadence: null,
    supportStrategy: {},
    successCriteria: {},
    status: "active",
    reviewState: "idle",
    metadata: {
      command: "/goal",
      lifeopsGoalWorkstream: {
        enabled: true,
        autoSpawnAgent: true,
        framework: "codex",
        label: "GoalScout",
        roomId: "room-1",
        workdir: "/tmp/eliza-work",
        recentContext: [
          {
            role: "user",
            text: "Need the output to name a concrete next action.",
            timestamp: 1780000000000,
          },
        ],
      },
      lifeopsGoalStyle: {
        kind: "sprint",
        label: "Sprint",
        promptHints: ["Prefer concrete next actions."],
      },
    },
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildLifeOpsGoalWorkstreamTaskInput", () => {
  it("builds a durable private orchestrator task for a LifeOps goal", () => {
    expect(buildLifeOpsGoalWorkstreamTaskInput(goal())).toMatchObject({
      title: "LifeOps: ship useful upstream PRs",
      kind: "lifeops_goal",
      priority: "normal",
      roomId: "room-1",
      taskRoomId: "room-1",
      originalRequest: "LifeOps goal created from /goal.",
      goal: expect.stringMatching(
        /Keep momentum on LifeOps goal: ship useful upstream PRs[\s\S]*user: Need the output to name a concrete next action\./,
      ),
      acceptanceCriteria: expect.arrayContaining([
        "Keep the goal moving with one concrete next action.",
      ]),
      metadata: {
        source: "lifeops_goal",
        lifeopsGoalId: "goal-1",
        sourceRoomId: "room-1",
        sourceWorkdir: "/tmp/eliza-work",
        sourceContextMessageCount: 1,
        privacyClass: "private",
        publicContextBlocked: true,
        lifeopsGoalStyle: expect.objectContaining({
          kind: "sprint",
          label: "Sprint",
        }),
      },
    });
  });
});
