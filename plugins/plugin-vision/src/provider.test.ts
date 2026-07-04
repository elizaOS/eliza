/**
 * Provider tests for composing fresh and stale vision context into agent state.
 */

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { visionProvider } from "./provider";
import { type SceneDescription, VisionMode } from "./types";

function makeRuntime(sceneDescription: SceneDescription): IAgentRuntime {
  const visionService = {
    getEnhancedSceneDescription: vi.fn(async () => sceneDescription),
    getSceneDescription: vi.fn(async () => sceneDescription),
    getCameraInfo: vi.fn(() => ({
      id: "camera-1",
      name: "Test Camera",
      connected: true,
    })),
    isActive: vi.fn(() => true),
    getVisionMode: vi.fn(() => VisionMode.CAMERA),
    getScreenCapture: vi.fn(async () => null),
    getEntityTracker: vi.fn(() => null),
  };

  return Object.assign(Object.create(null) as IAgentRuntime, {
    getService: vi.fn(<T>(name: string): T | null =>
      name === "VISION" ? (visionService as T) : null,
    ),
  });
}

describe("visionProvider", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ages stale VLM prose by descriptionTimestamp while fresh detections remain current", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);

    const runtime = makeRuntime({
      timestamp: 1_000_000,
      descriptionTimestamp: 880_000,
      description: "A desk from the previous VLM describe.",
      objects: [
        {
          id: "object-1",
          type: "keyboard",
          confidence: 0.98,
          boundingBox: { x: 1, y: 2, width: 3, height: 4 },
        },
      ],
      people: [],
      sceneChanged: true,
      changePercentage: 72,
      descriptionStale: true,
      describePaused: true,
      describePauseReason: "memory-cap",
    });

    const result = await visionProvider.get(
      runtime,
      { worldId: "world-1" } as Memory,
      {} as State,
    );

    expect(result.values?.sceneAge).toBe(120);
    expect(result.values?.descriptionStale).toBe(true);
    expect(result.values?.describePaused).toBe(true);
    expect(result.values?.describePauseReason).toBe("memory-cap");
    expect(result.values?.objectCount).toBe(1);
    expect(result.text).toContain(
      "VLM description is stale because describe is paused (memory-cap)",
    );
  });
});
