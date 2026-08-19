import { describe, expect, it } from "vitest";
import { createMockRuntime } from "@elizaos/core/testing";
import { settleDelayedTrajectoryReward } from "./trajectory-storage";

describe("settleDelayedTrajectoryReward JsonValue contract", () => {
  it("persists rewardComponents with JsonValue-compatible entries", async () => {
    const runtime = createMockRuntime();
    const trajectoryId = "trajectory-reward-json-contract";
    const rewardInfo = {
      components: {
        environmentReward: 0.75,
        bonus: "string-value",
        nested: { foo: 1 },
        arr: [1, "x"],
      },
    };

    await settleDelayedTrajectoryReward(runtime, trajectoryId, {}, rewardInfo);

    const list = await runtime.getTrajectoryStore().listTrajectories({
      limit: 1,
      offset: 0,
    });
    const item = list.trajectories.find((t) => t.id === trajectoryId);
    expect(item).toBeDefined();
    expect(item!.rewardComponents).toEqual({
      environmentReward: 0.75,
      bonus: "string-value",
      nested: { foo: 1 },
      arr: [1, "x"],
    });
  });

  it("preserves idempotent accumulation on repeated settle", async () => {
    const runtime = createMockRuntime();
    const trajectoryId = "trajectory-reward-json-idempotent";

    await settleDelayedTrajectoryReward(runtime, trajectoryId, {}, {
      components: { a: 1 },
    });
    await settleDelayedTrajectoryReward(runtime, trajectoryId, {}, {
      components: { b: 2 },
    });

    const list = await runtime.getTrajectoryStore().listTrajectories({
      limit: 1,
      offset: 0,
    });
    const item = list.trajectories.find((t) => t.id === trajectoryId);
    expect(item!.rewardComponents).toEqual({ a: 1, b: 2 });
  });
});
