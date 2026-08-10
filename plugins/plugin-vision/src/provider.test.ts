/**
 * Provider tests for composing fresh and stale vision context into agent state.
 */

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { visionProvider } from "./provider";
import {
  type SceneDescription,
  type VisionCapabilities,
  VisionMode,
} from "./types";

function makeRuntime(
  sceneDescription: SceneDescription,
  overrides?: { capabilities?: VisionCapabilities; isActive?: boolean },
): IAgentRuntime {
  const defaultCaps: VisionCapabilities = {
    objectDetection: false,
    ocr: true,
    faceRecognition: false,
    screenCapture: false,
    camera: true,
    audio: false,
    unavailableReasons: {
      objectDetection: "Object detection not enabled",
      faceRecognition: "Face recognition backend not initialized or not enabled",
      screenCapture: "Screen mode not active",
      audio: "Audio capture not configured",
    },
  };

  const visionService = {
    getEnhancedSceneDescription: vi.fn(async () => sceneDescription),
    getSceneDescription: vi.fn(async () => sceneDescription),
    getCameraInfo: vi.fn(() => ({
      id: "camera-1",
      name: "Test Camera",
      connected: true,
    })),
    isActive: vi.fn(() => overrides?.isActive ?? true),
    getVisionMode: vi.fn(() => VisionMode.CAMERA),
    getScreenCapture: vi.fn(async () => null),
    getEntityTracker: vi.fn(() => null),
    getCapabilities: vi.fn(() => overrides?.capabilities ?? defaultCaps),
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

  it("surfaces capability readiness honestly when backends are unavailable", async () => {
    const runtime = makeRuntime(
      {
        timestamp: Date.now(),
        description: "Scene with no YOLO.",
        objects: [
          {
            id: "obj-1",
            type: "chair",
            confidence: 0.6,
            boundingBox: { x: 0, y: 0, width: 10, height: 10 },
          },
        ],
        people: [],
        sceneChanged: false,
        changePercentage: 5,
        objectDetectionSource: "motion",
      },
      {
        capabilities: {
          objectDetection: false,
          ocr: false,
          faceRecognition: false,
          screenCapture: false,
          camera: true,
          audio: false,
          unavailableReasons: {
            objectDetection: "native library failed to load",
            ocr: "OCR not enabled",
            faceRecognition: "Face recognition backend not initialized or not enabled",
            screenCapture: "Screen mode not active",
            audio: "Audio capture not configured",
          },
        },
      },
    );

    const result = await visionProvider.get(
      runtime,
      { worldId: "world-1" } as Memory,
      {} as State,
    );

    const caps = result.values?.capabilities as VisionCapabilities;

    // Capabilities are surfaced with honest false values.
    expect(caps).toBeDefined();
    expect(caps.objectDetection).toBe(false);
    expect(caps.ocr).toBe(false);
    expect(caps.faceRecognition).toBe(false);
    // Camera IS available.
    expect(caps.camera).toBe(true);
    // Unavailable reasons are provided for each false capability.
    expect(caps.unavailableReasons?.objectDetection).toBe(
      "native library failed to load",
    );
    expect(caps.unavailableReasons?.ocr).toBe("OCR not enabled");

    // Detection provenance is surfaced: objects came from motion heuristics.
    expect(result.values?.objectDetectionSource).toBe("motion");
    expect(result.text).toContain("via motion heuristics");
  });

  it("reports all-capabilities-available when backends are initialized", async () => {
    const runtime = makeRuntime(
      {
        timestamp: Date.now(),
        description: "Full vision scene.",
        objects: [
          {
            id: "obj-1",
            type: "person",
            confidence: 0.95,
            boundingBox: { x: 0, y: 0, width: 100, height: 200 },
          },
        ],
        people: [],
        sceneChanged: true,
        changePercentage: 30,
        objectDetectionSource: "yolo",
      },
      {
        capabilities: {
          objectDetection: true,
          ocr: true,
          faceRecognition: true,
          screenCapture: true,
          camera: true,
          audio: true,
        },
      },
    );

    const result = await visionProvider.get(
      runtime,
      { worldId: "world-1" } as Memory,
      {} as State,
    );

    const caps = result.values?.capabilities as VisionCapabilities;

    expect(caps.objectDetection).toBe(true);
    expect(caps.ocr).toBe(true);
    expect(caps.faceRecognition).toBe(true);
    expect(caps.screenCapture).toBe(true);
    expect(caps.camera).toBe(true);
    expect(caps.audio).toBe(true);
    // No unavailable reasons when all are available.
    expect(caps.unavailableReasons).toBeUndefined();

    // Detection provenance shows YOLO.
    expect(result.values?.objectDetectionSource).toBe("yolo");
    expect(result.text).toContain("via YOLO");
  });

  it("includes capabilities in the inactive/service-not-started state", async () => {
    const runtime = makeRuntime(
      {
        timestamp: 0,
        description: "",
        objects: [],
        people: [],
        sceneChanged: false,
        changePercentage: 0,
      },
      {
        isActive: false,
        capabilities: {
          objectDetection: false,
          ocr: false,
          faceRecognition: false,
          screenCapture: false,
          camera: false,
          audio: false,
          unavailableReasons: {
            camera: "No camera connected",
            objectDetection: "Object detection not enabled",
            ocr: "OCR not enabled",
            faceRecognition: "Face recognition backend not initialized or not enabled",
            screenCapture: "Screen mode not active",
            audio: "Audio capture not configured",
          },
        },
      },
    );

    const result = await visionProvider.get(
      runtime,
      { worldId: "world-1" } as Memory,
      {} as State,
    );

    const caps = result.values?.capabilities as VisionCapabilities;

    expect(result.values?.visionAvailable).toBe(false);
    expect(caps).toBeDefined();
    expect(caps.camera).toBe(false);
    expect(caps.unavailableReasons?.camera).toBe("No camera connected");
  });
});
