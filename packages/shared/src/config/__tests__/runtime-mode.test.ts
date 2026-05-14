import { describe, expect, it } from "vitest";

import {
  isCloudRuntimeMode,
  isLocalRuntimeMode,
  isSafeLocalMode,
  isYoloLocalMode,
  normalizeRuntimeExecutionMode,
  readRuntimeExecutionModeConfig,
  resolveRuntimeExecutionMode,
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

  it("preserves explicit local-yolo only for unrestricted local targets", () => {
    expect(
      readRuntimeExecutionModeConfig({
        runtime: { executionMode: "local-yolo" },
        deploymentTarget: { runtime: "local" },
        distributionProfile: "unrestricted",
      }),
    ).toBe("local-yolo");
  });

  it("clamps explicit local-yolo for cloud, store, remote, and mobile targets", () => {
    expect(
      readRuntimeExecutionModeConfig({
        runtime: { executionMode: "local-yolo" },
        deploymentTarget: { runtime: "cloud" },
      }),
    ).toBe("cloud");
    expect(
      readRuntimeExecutionModeConfig({
        runtime: { executionMode: "local-yolo" },
        deploymentTarget: { runtime: "local" },
        distributionProfile: "store",
      }),
    ).toBe("local-safe");
    expect(
      readRuntimeExecutionModeConfig({
        runtime: { executionMode: "local-yolo" },
        deploymentTarget: { runtime: "remote" },
      }),
    ).toBe("local-safe");
    expect(
      readRuntimeExecutionModeConfig({
        runtime: { executionMode: "local-yolo" },
        platform: "ios",
      }),
    ).toBe("local-safe");
  });

  it("falls back to the safest mode for known deployment targets", () => {
    expect(
      readRuntimeExecutionModeConfig({
        deploymentTarget: { runtime: "cloud" },
      }),
    ).toBe("cloud");
    expect(readRuntimeExecutionModeConfig({})).toBe("local-safe");
  });

  it("defaults env-driven resolution to host-yolo only for unrestricted direct desktop contexts", () => {
    expect(resolveRuntimeExecutionMode(null, { env: {} })).toBe("local-yolo");
    expect(
      resolveRuntimeExecutionMode(null, {
        env: { ELIZA_DISTRIBUTION_PROFILE: "store" },
      }),
    ).toBe("local-safe");
    expect(
      resolveRuntimeExecutionMode(null, {
        env: { ELIZA_PLATFORM: "android" },
      }),
    ).toBe("local-safe");
    expect(
      resolveRuntimeExecutionMode(null, {
        deploymentTarget: { runtime: "cloud" },
        env: {},
      }),
    ).toBe("cloud");
  });

  it("clamps explicit env local-yolo outside unrestricted direct desktop contexts", () => {
    expect(
      resolveRuntimeExecutionMode(null, {
        env: {
          ELIZA_DISTRIBUTION_PROFILE: "store",
          ELIZA_RUNTIME_MODE: "local-yolo",
        },
      }),
    ).toBe("local-safe");
    expect(
      resolveRuntimeExecutionMode(null, {
        env: { ELIZA_PLATFORM: "ios", ELIZA_RUNTIME_MODE: "local-yolo" },
      }),
    ).toBe("local-safe");
  });
});
