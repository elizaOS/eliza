/**
 * Capability-state regressions for the real VisionService lifecycle proxies.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { VisionService } from "./service";
import { VisionMode } from "./types";

function makeRuntime(): IAgentRuntime {
  return Object.assign(Object.create(null) as IAgentRuntime, {
    agentId: "agent",
    character: {},
    getSetting: vi.fn(() => undefined),
    getService: vi.fn(() => null),
    getServicesByType: vi.fn(() => []),
  });
}

describe("VisionService capability readiness", () => {
  it("does not confuse scheduled loops or allocated objects with ready backends", () => {
    const service = new VisionService(makeRuntime());
    Reflect.set(service, "visionConfig", {
      visionMode: VisionMode.SCREEN,
      enableObjectDetection: true,
      enableFaceRecognition: true,
      ocrEnabled: true,
    });
    Reflect.set(service, "screenProcessingInterval", { scheduled: true });
    Reflect.set(service, "objectDetector", {});
    Reflect.set(service, "hasObjectDetection", false);
    Reflect.set(service, "faceRecognition", { isInitialized: () => false });
    Reflect.set(service, "hasFaceRecognition", true);
    Reflect.set(service, "audioCapture", { isActive: () => false });
    Reflect.set(service, "ocrService", { isInitialized: () => false });

    const capabilities = service.getCapabilities();

    expect(capabilities).toMatchObject({
      objectDetection: false,
      ocr: false,
      faceRecognition: false,
      screenCapture: false,
      camera: false,
      audio: false,
    });
    expect(capabilities.unavailableReasons?.screenCapture).toContain(
      "first successful frame",
    );
  });

  it("reports ready only after every backend-specific readiness check passes", () => {
    const service = new VisionService(makeRuntime());
    Reflect.set(service, "visionConfig", {
      visionMode: VisionMode.BOTH,
      enableObjectDetection: true,
      enableFaceRecognition: true,
      ocrEnabled: true,
    });
    Reflect.set(service, "objectDetector", {});
    Reflect.set(service, "hasObjectDetection", true);
    Reflect.set(service, "faceRecognition", { isInitialized: () => true });
    Reflect.set(service, "hasFaceRecognition", true);
    Reflect.set(service, "screenCaptureReady", true);
    Reflect.set(service, "camera", {});
    Reflect.set(service, "audioCapture", { isActive: () => true });
    Reflect.set(service, "ocrService", { isInitialized: () => true });

    expect(service.getCapabilities()).toEqual({
      objectDetection: true,
      ocr: true,
      faceRecognition: true,
      screenCapture: true,
      camera: true,
      audio: true,
    });
  });

  it("changes screen readiness only after real capture outcomes and clears it on stop", async () => {
    const service = new VisionService(makeRuntime());
    Reflect.set(service, "visionConfig", {
      visionMode: VisionMode.SCREEN,
      ocrEnabled: false,
    });
    const captureScreen = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce({
        timestamp: Date.now(),
        width: 1,
        height: 1,
        data: Buffer.from("frame"),
        tiles: [],
      });
    Reflect.set(service, "screenCapture", {
      captureScreen,
      getActiveTile: () => null,
    });
    Reflect.set(
      service,
      "updateEnhancedSceneDescription",
      vi.fn(async () => undefined),
    );
    const captureAndProcessScreen = Reflect.get(
      service,
      "captureAndProcessScreen",
    ) as () => Promise<void>;

    await captureAndProcessScreen.call(service);
    expect(service.getCapabilities().screenCapture).toBe(false);
    expect(
      service.getCapabilities().unavailableReasons?.screenCapture,
    ).toContain("permission");

    await captureAndProcessScreen.call(service);
    expect(service.getCapabilities().screenCapture).toBe(true);

    Reflect.set(service, "screenProcessingInterval", { scheduled: true });
    const stopProcessing = Reflect.get(service, "stopProcessing") as () => void;
    stopProcessing.call(service);
    expect(service.getCapabilities().screenCapture).toBe(false);
  });
});
