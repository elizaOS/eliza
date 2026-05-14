import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { VisionService } from "./service";

function createRuntime(opts: {
  eliza1HandlerPresent?: boolean;
  imageDescriptionResult?: unknown;
}) {
  const llmCalls: Record<string, unknown>[] = [];
  const trajectoryLogger = {
    isEnabled: () => true,
    startTrajectory: vi.fn(() => "traj"),
    startStep: vi.fn(() => "step"),
    endTrajectory: vi.fn(),
    flushWriteQueue: vi.fn(),
    logLlmCall: vi.fn((call: Record<string, unknown>) => {
      llmCalls.push(call);
    }),
  };
  const settings = new Map<string, unknown>();
  if (opts.eliza1HandlerPresent) {
    settings.set("ELIZA1_VISION_HANDLER_PRESENT", "1");
  }
  const useModel = vi.fn(async (_t: string, _args: unknown) => opts.imageDescriptionResult);
  const runtime = Object.assign(Object.create(null) as IAgentRuntime, {
    agentId: "agent-vision",
    character: {},
    getSetting: vi.fn((key: string) => settings.get(key)),
    getService: vi.fn((name: string) =>
      name === "trajectories" ? trajectoryLogger : null,
    ),
    getServicesByType: vi.fn(() => []),
    useModel,
  });
  return { runtime, trajectoryLogger, useModel, llmCalls };
}

describe("VisionService eliza-1 IMAGE_DESCRIPTION bridge", () => {
  it("prefers the runtime IMAGE_DESCRIPTION handler when WS2 marker is set", async () => {
    const { runtime, useModel } = createRuntime({
      eliza1HandlerPresent: true,
      imageDescriptionResult: { description: "Eliza-1 sees a desk." },
    });
    const service = new VisionService(runtime);
    const florenceAnalyze = vi.fn();
    Object.defineProperty(service, "florence2", {
      configurable: true,
      value: { isInitialized: () => true, analyzeImage: florenceAnalyze },
    });

    const describe = Reflect.get(service, "describeSceneWithVLM") as (
      imageUrl: string,
    ) => Promise<string>;
    const result = await describe.call(
      service,
      `data:image/jpeg;base64,${Buffer.from("img").toString("base64")}`,
    );
    expect(result).toBe("Eliza-1 sees a desk.");
    expect(useModel).toHaveBeenCalledTimes(1);
    expect(florenceAnalyze).not.toHaveBeenCalled();
  });

  it("falls back to Florence-2 when eliza-1 handler is absent", async () => {
    const { runtime, useModel } = createRuntime({ eliza1HandlerPresent: false });
    const service = new VisionService(runtime);
    const florenceAnalyze = vi.fn(async () => ({ caption: "Florence2 caption" }));
    Object.defineProperty(service, "florence2", {
      configurable: true,
      value: { isInitialized: () => true, analyzeImage: florenceAnalyze },
    });
    const describe = Reflect.get(service, "describeSceneWithVLM") as (
      imageUrl: string,
    ) => Promise<string>;
    const result = await describe.call(
      service,
      `data:image/jpeg;base64,${Buffer.from("img").toString("base64")}`,
    );
    expect(result).toBe("Florence2 caption");
    expect(useModel).not.toHaveBeenCalled();
    expect(florenceAnalyze).toHaveBeenCalledTimes(1);
  });

  it("falls back when eliza-1 returns the unhelpful sentinel", async () => {
    const { runtime } = createRuntime({
      eliza1HandlerPresent: true,
      imageDescriptionResult: { description: "I'm unable to analyze images" },
    });
    const service = new VisionService(runtime);
    const florenceAnalyze = vi.fn(async () => ({ caption: "ok" }));
    Object.defineProperty(service, "florence2", {
      configurable: true,
      value: { isInitialized: () => true, analyzeImage: florenceAnalyze },
    });
    const describe = Reflect.get(service, "describeSceneWithVLM") as (
      imageUrl: string,
    ) => Promise<string>;
    const result = await describe.call(
      service,
      `data:image/jpeg;base64,${Buffer.from("img").toString("base64")}`,
    );
    expect(result).toBe("ok");
    expect(florenceAnalyze).toHaveBeenCalledTimes(1);
  });
});
