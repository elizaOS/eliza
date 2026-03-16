import { asUUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { describe, expect, it } from "vitest";
import {
  extractSharedPrefix,
  groupTrajectories,
  prepareForRULER,
  toARTMessages,
  toARTTrajectory,
  validateARTCompatibility,
} from "../art-format";
import { TrajectoryLoggerService } from "../TrajectoryLoggerService";
import type { Trajectory } from "../types";

function makeTrajectory(params: {
  scenarioId?: string;
  systemPrompt?: string;
  userPrompt?: string;
  response?: string;
}): Trajectory {
  const trajectoryId = asUUID(uuidv4());
  const agentId = asUUID(uuidv4());
  const stepId = asUUID(uuidv4());
  const now = Date.now();

  return {
    trajectoryId,
    agentId,
    startTime: now,
    endTime: now,
    durationMs: 0,
    scenarioId: params.scenarioId,
    steps: [
      {
        stepId,
        stepNumber: 0,
        timestamp: now,
        environmentState: {
          timestamp: now,
          agentBalance: 100,
          agentPoints: 0,
          agentPnL: 0,
          openPositions: 0,
        },
        observation: {},
        llmCalls: [
          {
            callId: uuidv4(),
            timestamp: now,
            model: "test-model",
            systemPrompt: params.systemPrompt || "You are a trading agent.",
            userPrompt: params.userPrompt || "BTC at 50%. Trade?",
            response: params.response || "I will hold.",
            temperature: 0.7,
            maxTokens: 512,
            purpose: "action",
          },
        ],
        providerAccesses: [],
        action: {
          attemptId: uuidv4(),
          timestamp: now,
          actionType: "HOLD",
          actionName: "HOLD",
          parameters: {},
          success: true,
        },
        reward: 0.5,
        done: true,
      },
    ],
    totalReward: 0.5,
    rewardComponents: { environmentReward: 0.5 },
    metrics: { episodeLength: 1, finalStatus: "completed" },
    metadata: {},
  };
}

describe("plugin-trajectory-logger ART formatting", () => {
  it("converts a trajectory into an ART message array", () => {
    const t = makeTrajectory({});
    const messages = toARTMessages(t);

    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.role).toBe("user");
    expect(messages[2]?.role).toBe("assistant");
  });

  it("converts a trajectory into an ART trajectory object", () => {
    const t = makeTrajectory({});
    const art = toARTTrajectory(t);

    expect(art.messages.length).toBeGreaterThanOrEqual(2);
    expect(art.reward).toBe(0.5);
    expect(art.metadata.trajectoryId).toBe(t.trajectoryId);
  });

  it("groups trajectories by scenario and extracts shared prefix", () => {
    const t1 = makeTrajectory({ scenarioId: "s1", response: "A" });
    const t2 = makeTrajectory({ scenarioId: "s1", response: "B" });
    const t3 = makeTrajectory({ scenarioId: "s2", response: "C" });

    const groups = groupTrajectories([t1, t2, t3]);
    expect(groups.length).toBe(2);

    const s1 = groups.find((g) => g.scenarioId === "s1");
    if (!s1) {
      throw new Error("Expected scenario group 's1'");
    }

    const prefix = extractSharedPrefix([t1, t2]);
    expect(prefix.length).toBeGreaterThan(0);

    const ruler = prepareForRULER(s1);
    expect(ruler.sharedPrefix.length).toBeGreaterThan(0);
    expect(ruler.suffixes.length).toBe(2);
  });

  it("validates ART compatibility", () => {
    const t = makeTrajectory({});
    const result = validateARTCompatibility(t);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("TrajectoryLoggerService", () => {
  it("records steps and ends a trajectory", async () => {
    const svc = new TrajectoryLoggerService();
    const agentId = uuidv4();
    const trajectoryId = svc.startTrajectory(agentId);

    const stepId = svc.startStep(trajectoryId, {
      timestamp: Date.now(),
      agentBalance: 0,
      agentPoints: 0,
      agentPnL: 0,
      openPositions: 0,
    });

    svc.logLLMCall(stepId, {
      model: "test-model",
      systemPrompt: "sys",
      userPrompt: "user",
      response: "assistant",
      temperature: 0.7,
      maxTokens: 32,
      purpose: "action",
    });

    svc.completeStep(trajectoryId, stepId, {
      actionType: "TEST",
      actionName: "TEST",
      parameters: {},
      success: true,
    });

    await svc.endTrajectory(trajectoryId, "completed");

    const traj = svc.getActiveTrajectory(trajectoryId);
    expect(traj).toBeTruthy();
    expect(traj?.steps.length).toBe(1);
    expect(traj?.metrics.episodeLength).toBe(1);
  });
});
