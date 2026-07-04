/**
 * Bridge tests for routing scene descriptions through the eliza-1 image model slot.
 */

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
    const prompt = JSON.parse(
      (useModel.mock.calls[0]?.[1] as { prompt: string }).prompt,
    ) as Record<string, unknown>;
    expect(prompt.detectedText).toBeUndefined();
  });

  it("adds current OCR text to the scene description prompt", async () => {
    const { runtime, useModel } = createRuntime({
      imageDescriptionResult: { description: "The settings panel is open." },
    });
    const service = new VisionService(runtime);
    Object.defineProperty(service, "lastEnhancedScene", {
      configurable: true,
      value: {
        timestamp: Date.now(),
        description: "",
        objects: [],
        people: [],
        sceneChanged: true,
        changePercentage: 0,
        screenAnalysis: {
          fullScreenOCR: "Save\nSave\n  Project   settings\n\nDeploy now",
          activeTile: {
            timestamp: Date.now(),
            text: "Deploy now",
          },
        },
      },
    });

    const describeFn = Reflect.get(service, "describeSceneWithVLM") as (
      imageUrl: string,
    ) => Promise<string>;
    const result = await describeFn.call(
      service,
      `data:image/jpeg;base64,${Buffer.from("img").toString("base64")}`,
    );

    expect(result).toBe("The settings panel is open.");
    const prompt = JSON.parse(
      (useModel.mock.calls[0]?.[1] as { prompt: string }).prompt,
    ) as { detectedText?: string };
    expect(prompt.detectedText).toBe("Save\nProject settings\nDeploy now");
  });

  // Token-budget guards (#9105): OCR text fused into the IMAGE_DESCRIPTION prompt
  // is cheap vs re-describing, but must not blow the budget; service.ts clamps
  // it to SCENE_DESCRIPTION_OCR_LINE_LIMIT (40 lines) and
  // SCENE_DESCRIPTION_OCR_TEXT_LIMIT (2000 chars) in normalizeOcrTextForPrompt.
  function sceneWithOcr(service: VisionService, fullScreenOCR: string): void {
    Object.defineProperty(service, "lastEnhancedScene", {
      configurable: true,
      value: {
        timestamp: Date.now(),
        description: "",
        objects: [],
        people: [],
        sceneChanged: true,
        changePercentage: 0,
        screenAnalysis: {
          fullScreenOCR,
          activeTile: { timestamp: Date.now(), text: "" },
        },
      },
    });
  }

  it("clamps the prompt OCR to the 40-line token-budget limit", async () => {
    const { runtime, useModel } = createRuntime({
      imageDescriptionResult: { description: "A long list." },
    });
    const service = new VisionService(runtime);
    // 60 distinct short lines; without the cap the prompt would carry all 60.
    sceneWithOcr(
      service,
      Array.from({ length: 60 }, (_, i) => `row ${i}`).join("\n"),
    );
    const describeFn = Reflect.get(service, "describeSceneWithVLM") as (
      imageUrl: string,
    ) => Promise<string>;
    await describeFn.call(
      service,
      `data:image/jpeg;base64,${Buffer.from("img").toString("base64")}`,
    );
    const prompt = JSON.parse(
      (useModel.mock.calls[0]?.[1] as { prompt: string }).prompt,
    ) as { detectedText?: string };
    expect(prompt.detectedText).toBeTruthy();
    expect((prompt.detectedText ?? "").split("\n")).toHaveLength(40);
  });

  it("clamps the prompt OCR to the 2000-char token-budget limit", async () => {
    const { runtime, useModel } = createRuntime({
      imageDescriptionResult: { description: "A wall of text." },
    });
    const service = new VisionService(runtime);
    // Three distinct ~1000-char lines (~3000 chars total), under the 40-line
    // cap but well over the 2000-char cap; without the slice it would be ~3000.
    sceneWithOcr(
      service,
      [0, 1, 2].map((i) => `${i} ${"x".repeat(1000)}`).join("\n"),
    );
    const describeFn = Reflect.get(service, "describeSceneWithVLM") as (
      imageUrl: string,
    ) => Promise<string>;
    await describeFn.call(
      service,
      `data:image/jpeg;base64,${Buffer.from("img").toString("base64")}`,
    );
    const prompt = JSON.parse(
      (useModel.mock.calls[0]?.[1] as { prompt: string }).prompt,
    ) as { detectedText?: string };
    expect(prompt.detectedText).toBeTruthy();
    expect((prompt.detectedText ?? "").length).toBeLessThanOrEqual(2000);
    expect((prompt.detectedText ?? "").length).toBeGreaterThan(1900);
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
