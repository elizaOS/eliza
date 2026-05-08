import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { VisionService } from "./service";

function createRuntime() {
  const llmCalls: Record<string, unknown>[] = [];
  const trajectoryLogger = {
    isEnabled: () => true,
    startTrajectory: vi.fn(() => "vision-traj"),
    startStep: vi.fn(() => "vision-step"),
    endTrajectory: vi.fn(),
    flushWriteQueue: vi.fn(),
    logLlmCall: vi.fn((call: Record<string, unknown>) => {
      llmCalls.push(call);
    }),
  };
  const runtime = {
    agentId: "agent-vision",
    character: {},
    getSetting: vi.fn(() => undefined),
    getService: vi.fn((name: string) =>
      name === "trajectories" ? trajectoryLogger : null,
    ),
    getServicesByType: vi.fn((type: string) =>
      type === "trajectories" ? [trajectoryLogger] : [],
    ),
  } as unknown as IAgentRuntime;

  return { runtime, trajectoryLogger, llmCalls };
}

describe("vision trajectory capture", () => {
  it("records local Florence image analysis in a standalone trajectory", async () => {
    const { runtime, trajectoryLogger, llmCalls } = createRuntime();
    const service = new VisionService(runtime);
    const analyzeImage = vi.fn(async () => ({ caption: "A tidy desk." }));
    (service as any).florence2 = {
      isInitialized: () => true,
      analyzeImage,
    };

    const description = await (service as any).describeSceneWithVLM(
      `data:image/jpeg;base64,${Buffer.from("image").toString("base64")}`,
    );

    expect(description).toBe("A tidy desk.");
    expect(analyzeImage).toHaveBeenCalledWith(Buffer.from("image"));
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
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]).toMatchObject({
      stepId: "vision-step",
      model: "florence2-local",
      purpose: "background",
      actionType: "florence2.analyzeImage",
    });
    expect(JSON.parse(String(llmCalls[0]?.userPrompt))).toEqual({
      task: "describe_visual_scene",
      image: {
        source: "camera_frame",
        mimeType: "image/jpeg",
        bytes: Buffer.from("image").byteLength,
      },
    });
  });
});
