import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { VisionService } from "./service";

function createRuntime() {
  const trajectoryLogger = {
    isEnabled: () => true,
    startTrajectory: vi.fn(() => "vision-traj"),
    startStep: vi.fn(() => "vision-step"),
    endTrajectory: vi.fn(),
    flushWriteQueue: vi.fn(),
    logLlmCall: vi.fn(),
  };
  const useModel = vi.fn(async (_t: string, _args: unknown) => ({
    description: "A tidy desk.",
  }));
  const runtime = Object.assign(Object.create(null) as IAgentRuntime, {
    agentId: "agent-vision",
    character: {},
    getSetting: vi.fn(() => undefined),
    getService: vi.fn((name: string) =>
      name === "trajectories" ? trajectoryLogger : null,
    ),
    getServicesByType: vi.fn((type: string) =>
      type === "trajectories" ? [trajectoryLogger] : [],
    ),
    useModel,
  });

  return { runtime, trajectoryLogger, useModel };
}

describe("vision trajectory capture", () => {
  it("wraps the eliza-1 IMAGE_DESCRIPTION call in a standalone trajectory", async () => {
    const { runtime, trajectoryLogger, useModel } = createRuntime();
    const service = new VisionService(runtime);

    const describeSceneWithVLM = Reflect.get(
      service,
      "describeSceneWithVLM",
    ) as (imageUrl: string) => Promise<string>;
    const description = await describeSceneWithVLM.call(
      service,
      `data:image/jpeg;base64,${Buffer.from("image").toString("base64")}`,
    );

    expect(description).toBe("A tidy desk.");
    expect(useModel).toHaveBeenCalledWith(
      "IMAGE_DESCRIPTION",
      expect.objectContaining({ imageUrl: expect.any(String) }),
    );
    expect(trajectoryLogger.startTrajectory).toHaveBeenCalledWith(
      "agent-vision",
      expect.objectContaining({
        source: "plugin-vision:scene-description",
      }),
    );
    expect(trajectoryLogger.endTrajectory).toHaveBeenCalledWith(
      "vision-traj",
      "completed",
    );
  });
});
