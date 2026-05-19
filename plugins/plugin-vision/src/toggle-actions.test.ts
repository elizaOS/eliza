import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { VisionService } from "./service";
import { VisionMode } from "./types";

function makeRuntime() {
  const trajectoryLogger = {
    isEnabled: () => true,
    startTrajectory: vi.fn(() => "t"),
    startStep: vi.fn(() => "s"),
    endTrajectory: vi.fn(),
    flushWriteQueue: vi.fn(),
    logLlmCall: vi.fn(),
  };
  return Object.assign(Object.create(null) as IAgentRuntime, {
    agentId: "agent",
    character: {},
    getSetting: vi.fn(() => undefined),
    getService: vi.fn((name: string) =>
      name === "trajectories" ? trajectoryLogger : null,
    ),
    getServicesByType: vi.fn(() => []),
  });
}

describe("VisionService camera/screen toggle actions", () => {
  it("enableCamera switches from OFF to CAMERA", async () => {
    const svc = new VisionService(makeRuntime());
    Object.defineProperty(svc, "visionConfig", {
      configurable: true,
      value: { visionMode: VisionMode.OFF },
    });
    const setMode = vi.spyOn(svc, "setVisionMode").mockResolvedValue();
    await svc.enableCamera();
    expect(setMode).toHaveBeenCalledWith(VisionMode.CAMERA);
  });

  it("enableCamera switches from SCREEN to BOTH", async () => {
    const svc = new VisionService(makeRuntime());
    Object.defineProperty(svc, "visionConfig", {
      configurable: true,
      value: { visionMode: VisionMode.SCREEN },
    });
    const setMode = vi.spyOn(svc, "setVisionMode").mockResolvedValue();
    await svc.enableCamera();
    expect(setMode).toHaveBeenCalledWith(VisionMode.BOTH);
  });

  it("disableCamera switches from BOTH to SCREEN", async () => {
    const svc = new VisionService(makeRuntime());
    Object.defineProperty(svc, "visionConfig", {
      configurable: true,
      value: { visionMode: VisionMode.BOTH },
    });
    const setMode = vi.spyOn(svc, "setVisionMode").mockResolvedValue();
    await svc.disableCamera();
    expect(setMode).toHaveBeenCalledWith(VisionMode.SCREEN);
  });

  it("disableCamera switches from CAMERA to OFF", async () => {
    const svc = new VisionService(makeRuntime());
    Object.defineProperty(svc, "visionConfig", {
      configurable: true,
      value: { visionMode: VisionMode.CAMERA },
    });
    const setMode = vi.spyOn(svc, "setVisionMode").mockResolvedValue();
    await svc.disableCamera();
    expect(setMode).toHaveBeenCalledWith(VisionMode.OFF);
  });

  it("enableScreen propagates displayIds onto config", async () => {
    const svc = new VisionService(makeRuntime());
    Object.defineProperty(svc, "visionConfig", {
      configurable: true,
      writable: true,
      value: { visionMode: VisionMode.OFF },
    });
    const setMode = vi.spyOn(svc, "setVisionMode").mockResolvedValue();
    await svc.enableScreen([1, 2]);
    expect(setMode).toHaveBeenCalledWith(VisionMode.SCREEN);
    const cfg = Reflect.get(svc, "visionConfig") as {
      displayIndex?: number;
      captureAllDisplays?: boolean;
    };
    expect(cfg.displayIndex).toBe(1);
    expect(cfg.captureAllDisplays).toBe(true);
  });

  it("disableScreen switches from BOTH to CAMERA", async () => {
    const svc = new VisionService(makeRuntime());
    Object.defineProperty(svc, "visionConfig", {
      configurable: true,
      value: { visionMode: VisionMode.BOTH },
    });
    const setMode = vi.spyOn(svc, "setVisionMode").mockResolvedValue();
    await svc.disableScreen();
    expect(setMode).toHaveBeenCalledWith(VisionMode.CAMERA);
  });
});
