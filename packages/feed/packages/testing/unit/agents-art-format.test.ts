import { describe, expect, it } from "bun:test";
import {
  groupTrajectories,
  validateARTCompatibility,
} from "../../agents/src/plugins/plugin-trajectory-logger/src/art-format";
import type {
  Trajectory,
  TrajectoryGroup,
} from "../../agents/src/plugins/plugin-trajectory-logger/src/types";

/**
 * Trajectory → ART (RL training) conversion gate. validateARTCompatibility must
 * reject trajectories with no steps or no reward (can't train on them) while
 * accepting well-formed ones; groupTrajectories buckets by scenario for GRPO.
 */

const step = () => ({
  llmCalls: [
    {
      purpose: "action",
      systemPrompt: "You are an autonomous trading agent.",
      userPrompt: "Here is the market state, what do you do?",
      response: "I will hold this turn.",
    },
  ],
  environmentState: { agentBalance: 100, agentPnL: 0, openPositions: 0 },
  providerAccesses: [],
  action: { actionType: "hold", parameters: {} },
});

const traj = (over: Partial<Trajectory>): Trajectory =>
  ({
    steps: [step()],
    totalReward: 0.5,
    metadata: { agentName: "Bot", goalDescription: "profit" },
    metrics: { finalBalance: 100, finalPnL: 0 },
    scenarioId: "s1",
    agentId: "a1",
    trajectoryId: "t1",
    groupIndex: 0,
    ...over,
  }) as unknown as Trajectory;

describe("validateARTCompatibility", () => {
  it("accepts a well-formed trajectory", () => {
    const res = validateARTCompatibility(traj({}));
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("rejects no-steps and missing-reward trajectories", () => {
    const noSteps = validateARTCompatibility(traj({ steps: [] }));
    expect(noSteps.valid).toBe(false);
    expect(noSteps.errors.join(" ")).toMatch(/no steps/i);

    const noReward = validateARTCompatibility(
      traj({ totalReward: undefined as never }),
    );
    expect(noReward.valid).toBe(false);
    expect(noReward.errors.join(" ")).toMatch(/reward/i);
  });
});

describe("groupTrajectories", () => {
  it("buckets trajectories by scenarioId", () => {
    const groups = groupTrajectories([
      traj({ scenarioId: "s1" }),
      traj({ scenarioId: "s2" }),
      traj({ scenarioId: "s1" }),
    ]);
    expect(groups).toHaveLength(2);
    const s1 = groups.find((g: TrajectoryGroup) => g.scenarioId === "s1");
    expect(s1?.trajectories).toHaveLength(2);
  });
});
