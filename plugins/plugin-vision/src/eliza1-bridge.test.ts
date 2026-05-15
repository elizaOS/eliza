import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { VisionService } from "./service";

function createRuntime(opts: {
  imageDescriptionResult?: unknown;
  throwError?: Error;
}) {
  const trajectoryLogger = {
    isEnabled: () => true,
    startTrajectory: vi.fn(() => "traj"),
    startStep: vi.fn(() => "step"),
    endTrajectory: vi.fn(),
    flushWriteQueue: vi.fn(),
    logLlmCall: vi.fn(),
  };
  const useModel = vi.fn(async (_t: string, _args: unknown) => {
    if (opts.throwError) throw opts.throwError;
    return opts.imageDescriptionResult;
  });
  const runtime = Object.assign(Object.create(null) as IAgentRuntime, {
    agentId: "agent-vision",
    character: {},
    getSetting: vi.fn(() => undefined),
    getService: vi.fn((name: string) =>
      name === "trajectories" ? trajectoryLogger : null,
    ),
    getServicesByType: vi.fn(() => []),
    useModel,
  });
  return { runtime, trajectoryLogger, useModel };
}

describe("VisionService eliza-1 IMAGE_DESCRIPTION bridge", () => {
  it("routes scene description through runtime IMAGE_DESCRIPTION (eliza-1 owns the slot)", async () => {
    const { runtime, useModel } = createRuntime({
      imageDescriptionResult: { description: "Eliza-1 sees a desk." },
    });
    const service = new VisionService(runtime);

    const describeFn = Reflect.get(service, "describeSceneWithVLM") as (
      imageUrl: string,
    ) => Promise<string>;
    const result = await describeFn.call(
      service,
      `data:image/jpeg;base64,${Buffer.from("img").toString("base64")}`,
    );

    expect(result).toBe("Eliza-1 sees a desk.");
    expect(useModel).toHaveBeenCalledTimes(1);
    expect(useModel).toHaveBeenCalledWith(
      "IMAGE_DESCRIPTION",
      expect.objectContaining({
        imageUrl: expect.stringMatching(/^data:image\/jpeg;base64,/),
        prompt: expect.any(String),
      }),
    );
  });

  it("falls through to detected-objects synthesis when IMAGE_DESCRIPTION returns the unhelpful sentinel", async () => {
    const { runtime } = createRuntime({
      imageDescriptionResult: { description: "I'm unable to analyze images" },
    });
    const service = new VisionService(runtime);

    // Seed a previous scene description so the synthesis branch has something to work with.
    Object.defineProperty(service, "lastSceneDescription", {
      configurable: true,
      value: {
        timestamp: Date.now(),
        description: "",
        objects: [
          {
            id: "o1",
            type: "monitor",
            confidence: 0.9,
            boundingBox: { x: 0, y: 0, width: 10, height: 10 },
          },
        ],
        people: [],
        sceneChanged: true,
        changePercentage: 0,
      },
    });

    const describeFn = Reflect.get(service, "describeSceneWithVLM") as (
      imageUrl: string,
    ) => Promise<string>;
    const result = await describeFn.call(
      service,
      `data:image/jpeg;base64,${Buffer.from("img").toString("base64")}`,
    );

    expect(result).toContain("monitor");
  });

  it("falls through to detected-objects synthesis when IMAGE_DESCRIPTION throws", async () => {
    const { runtime } = createRuntime({
      throwError: new Error("no IMAGE_DESCRIPTION handler registered"),
    });
    const service = new VisionService(runtime);

    Object.defineProperty(service, "lastSceneDescription", {
      configurable: true,
      value: {
        timestamp: Date.now(),
        description: "",
        objects: [],
        people: [],
        sceneChanged: false,
        changePercentage: 0,
      },
    });

    const describeFn = Reflect.get(service, "describeSceneWithVLM") as (
      imageUrl: string,
    ) => Promise<string>;
    const result = await describeFn.call(
      service,
      `data:image/jpeg;base64,${Buffer.from("img").toString("base64")}`,
    );

    expect(result).toBe("Scene appears to be empty or static");
  });
});
