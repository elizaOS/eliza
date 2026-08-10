/**
 * Describe-action tests for screen-only readiness and enhanced-scene routing.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { visionAction } from "./action";
import { VisionMode } from "./types";

const UUID = "00000000-0000-4000-8000-000000000001" as const;

function makeMessage(): Memory {
  return {
    id: UUID,
    entityId: UUID,
    agentId: UUID,
    roomId: UUID,
    worldId: UUID,
    content: { text: "describe my screen" },
  };
}

describe("VISION describe readiness", () => {
  it("uses the enhanced screen scene when screen capture is the only ready input", async () => {
    const getEnhancedSceneDescription = vi.fn(async () => ({
      timestamp: Date.now(),
      description: "A terminal window is open.",
      objects: [],
      people: [],
      sceneChanged: false,
      changePercentage: 0,
      screenCapture: {
        timestamp: Date.now(),
        width: 1280,
        height: 720,
        data: Buffer.from("screen"),
        tiles: [],
      },
    }));
    const visionService = {
      isActive: () => true,
      getCapabilities: () => ({
        objectDetection: false,
        ocr: false,
        faceRecognition: false,
        screenCapture: true,
        camera: false,
        audio: false,
      }),
      getEnhancedSceneDescription,
      getSceneDescription: vi.fn(() => {
        throw new Error("camera-only scene accessor must not be used");
      }),
      getCameraInfo: () => null,
      getVisionMode: () => VisionMode.SCREEN,
    };
    const runtime = Object.assign(Object.create(null) as IAgentRuntime, {
      agentId: UUID,
      getService: vi.fn((name: string) =>
        name === "VISION" ? visionService : null,
      ),
      createMemory: vi.fn(async () => undefined),
    });

    const result = await visionAction.handler(
      runtime,
      makeMessage(),
      undefined,
      { action: "describe" },
    );

    expect(result?.success).toBe(true);
    expect(result?.text).toContain("Looking at the screen");
    expect(result?.text).toContain("A terminal window is open");
    expect(getEnhancedSceneDescription).toHaveBeenCalledOnce();
    expect(visionService.getSceneDescription).not.toHaveBeenCalled();
  });

  it("reports an inactive service as unavailable instead of indefinitely initializing", async () => {
    const callback = vi.fn(async () => undefined);
    const visionService = {
      isActive: () => false,
      getVisionMode: () => VisionMode.OFF,
      getCapabilities: () => ({
        objectDetection: false,
        ocr: false,
        faceRecognition: false,
        screenCapture: false,
        camera: false,
        audio: false,
      }),
    };
    const runtime = Object.assign(Object.create(null) as IAgentRuntime, {
      agentId: UUID,
      getService: vi.fn(() => visionService),
      createMemory: vi.fn(async () => undefined),
    });

    const result = await visionAction.handler(
      runtime,
      makeMessage(),
      undefined,
      { action: "describe" },
      callback,
    );

    expect(result?.success).toBe(false);
    expect(result?.data?.error).toContain("inactive");
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("No vision input is available"),
      }),
    );
  });

  it("surfaces the concrete backend reason while an active screen loop has no frame", async () => {
    const callback = vi.fn(async () => undefined);
    const visionService = {
      isActive: () => true,
      getVisionMode: () => VisionMode.SCREEN,
      getCapabilities: () => ({
        objectDetection: false,
        ocr: false,
        faceRecognition: false,
        screenCapture: false,
        camera: false,
        audio: false,
        unavailableReasons: {
          screenCapture: "Screen capture permission denied",
        },
      }),
    };
    const runtime = Object.assign(Object.create(null) as IAgentRuntime, {
      agentId: UUID,
      getService: vi.fn(() => visionService),
      createMemory: vi.fn(async () => undefined),
    });

    const result = await visionAction.handler(
      runtime,
      makeMessage(),
      undefined,
      { action: "describe" },
      callback,
    );

    expect(result?.success).toBe(false);
    expect(result?.data?.error).toBe("Screen capture permission denied");
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Screen capture permission denied"),
      }),
    );
  });
});
