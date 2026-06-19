import { describe, expect, it } from "vitest";

import {
  isCloudRuntimeMode,
  isLocalRuntimeMode,
  isSafeLocalMode,
  isYoloLocalMode,
  normalizeRuntimeExecutionMode,
  readRuntimeExecutionModeConfig,
  runtimeExecutionModeForDeploymentTarget,
} from "../runtime-mode";

describe("runtime execution modes", () => {
  it("normalizes known runtime execution modes", () => {
    expect(normalizeRuntimeExecutionMode("cloud")).toBe("cloud");
    expect(normalizeRuntimeExecutionMode(" local-safe ")).toBe("local-safe");
    expect(normalizeRuntimeExecutionMode("LOCAL-YOLO")).toBe("local-yolo");
    expect(normalizeRuntimeExecutionMode("local")).toBeNull();
  });

  it("exposes local safety predicates", () => {
    expect(isCloudRuntimeMode("cloud")).toBe(true);
    expect(isLocalRuntimeMode("local-safe")).toBe(true);
    expect(isLocalRuntimeMode("local-yolo")).toBe(true);
    expect(isSafeLocalMode("local-safe")).toBe(true);
    expect(isSafeLocalMode("local-yolo")).toBe(false);
    expect(isYoloLocalMode("local-yolo")).toBe(true);
    expect(isYoloLocalMode("cloud")).toBe(false);
  });

  it("derives default modes from deployment target", () => {
    expect(runtimeExecutionModeForDeploymentTarget({ runtime: "cloud" })).toBe(
      "cloud",
    );
    expect(runtimeExecutionModeForDeploymentTarget({ runtime: "local" })).toBe(
      "local-safe",
    );
    expect(runtimeExecutionModeForDeploymentTarget({ runtime: "remote" })).toBe(
      "local-safe",
    );
  });

  it("prefers explicit config mode and falls back to deployment target", () => {
    expect(
      readRuntimeExecutionModeConfig({
        runtime: { executionMode: "local-yolo" },
        deploymentTarget: { runtime: "cloud" },
      }),
    ).toBe("local-yolo");
    expect(
      readRuntimeExecutionModeConfig({
        deploymentTarget: { runtime: "cloud" },
      }),
    ).toBe("cloud");
    expect(readRuntimeExecutionModeConfig({})).toBe("local-safe");
  });
});
