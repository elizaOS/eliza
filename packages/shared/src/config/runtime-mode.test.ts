/**
 * Tests for runtime execution mode normalization, configuration reading, and environment resolvers.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isCloudExecutionMode,
  isCloudRuntimeMode,
  isLocalRuntimeMode,
  isSafeLocalMode,
  isYoloLocalMode,
  normalizeRuntimeExecutionMode,
  RUNTIME_EXECUTION_MODE_DEFINITIONS,
  RUNTIME_EXECUTION_MODES,
  readRuntimeExecutionModeConfig,
  resolveLocalExecutionMode,
  resolveRuntimeExecutionMode,
  runtimeExecutionModeForDeploymentTarget,
  shouldUseSandboxExecution,
} from "./runtime-mode.ts";

describe("runtime-mode normalization and predicates", () => {
  it("normalizes valid mode strings case-insensitively and trims whitespace", () => {
    expect(normalizeRuntimeExecutionMode("cloud")).toBe("cloud");
    expect(normalizeRuntimeExecutionMode("  CLOUD  ")).toBe("cloud");
    expect(normalizeRuntimeExecutionMode("local-safe")).toBe("local-safe");
    expect(normalizeRuntimeExecutionMode("LOCAL-YOLO")).toBe("local-yolo");
  });

  it("returns null for invalid or non-string mode values", () => {
    expect(normalizeRuntimeExecutionMode("invalid-mode")).toBeNull();
    expect(normalizeRuntimeExecutionMode("")).toBeNull();
    expect(normalizeRuntimeExecutionMode(null)).toBeNull();
    expect(normalizeRuntimeExecutionMode(undefined)).toBeNull();
    expect(normalizeRuntimeExecutionMode(42)).toBeNull();
  });

  it("evaluates mode predicates correctly", () => {
    expect(isCloudRuntimeMode("cloud")).toBe(true);
    expect(isCloudRuntimeMode("local-safe")).toBe(false);

    expect(isLocalRuntimeMode("local-safe")).toBe(true);
    expect(isLocalRuntimeMode("local-yolo")).toBe(true);
    expect(isLocalRuntimeMode("cloud")).toBe(false);

    expect(isSafeLocalMode("local-safe")).toBe(true);
    expect(isSafeLocalMode("local-yolo")).toBe(false);

    expect(isYoloLocalMode("local-yolo")).toBe(true);
    expect(isYoloLocalMode("local-safe")).toBe(false);
  });
});

describe("deployment target and config resolution", () => {
  it("resolves execution mode for deployment target", () => {
    expect(runtimeExecutionModeForDeploymentTarget({ runtime: "cloud" })).toBe(
      "cloud",
    );
    expect(runtimeExecutionModeForDeploymentTarget({ runtime: "local" })).toBe(
      "local-safe",
    );
    expect(runtimeExecutionModeForDeploymentTarget(null)).toBe("local-safe");
    expect(runtimeExecutionModeForDeploymentTarget(undefined)).toBe(
      "local-safe",
    );
  });

  it("reads explicit executionMode from config or falls back to deploymentTarget", () => {
    expect(
      readRuntimeExecutionModeConfig({
        runtime: { executionMode: "cloud" },
      }),
    ).toBe("cloud");

    expect(
      readRuntimeExecutionModeConfig({
        runtime: { executionMode: "local-safe" },
      }),
    ).toBe("local-safe");

    expect(
      readRuntimeExecutionModeConfig({
        deploymentTarget: { runtime: "cloud" },
      }),
    ).toBe("cloud");

    expect(readRuntimeExecutionModeConfig(null)).toBe("local-safe");
  });
});

describe("resolveRuntimeExecutionMode and helpers", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.ELIZA_RUNTIME_MODE;
    delete process.env.RUNTIME_MODE;
    delete process.env.LOCAL_RUNTIME_MODE;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("prioritizes source getSetting over environment variables", () => {
    process.env.ELIZA_RUNTIME_MODE = "cloud";
    const source = {
      getSetting: (key: string) =>
        key === "ELIZA_RUNTIME_MODE" ? "local-safe" : undefined,
    };

    expect(resolveRuntimeExecutionMode(source)).toBe("local-safe");
  });

  it("falls back to process.env when setting is absent", () => {
    process.env.ELIZA_RUNTIME_MODE = "cloud";
    expect(resolveRuntimeExecutionMode(null)).toBe("cloud");
  });

  it("defaults to local-yolo when no setting or env var is present", () => {
    expect(resolveRuntimeExecutionMode(null)).toBe("local-yolo");
  });

  it("correctly evaluates sandbox, local, and cloud helpers", () => {
    const safeSource = { getSetting: () => "local-safe" };
    const yoloSource = { getSetting: () => "local-yolo" };
    const cloudSource = { getSetting: () => "cloud" };

    expect(resolveLocalExecutionMode(safeSource)).toBe("local-safe");
    expect(resolveLocalExecutionMode(yoloSource)).toBe("local-yolo");
    expect(resolveLocalExecutionMode(cloudSource)).toBe("local-yolo");

    expect(shouldUseSandboxExecution(safeSource)).toBe(true);
    expect(shouldUseSandboxExecution(yoloSource)).toBe(false);
    expect(shouldUseSandboxExecution(cloudSource)).toBe(false);

    expect(isCloudExecutionMode(cloudSource)).toBe(true);
    expect(isCloudExecutionMode(safeSource)).toBe(false);
  });
});

describe("RUNTIME_EXECUTION_MODE_DEFINITIONS", () => {
  it("defines flags accurately for all modes", () => {
    for (const mode of RUNTIME_EXECUTION_MODES) {
      const def = RUNTIME_EXECUTION_MODE_DEFINITIONS[mode];
      expect(def.mode).toBe(mode);
      if (mode === "cloud") {
        expect(def.cloud).toBe(true);
        expect(def.local).toBe(false);
      } else {
        expect(def.cloud).toBe(false);
        expect(def.local).toBe(true);
      }
    }
  });
});
