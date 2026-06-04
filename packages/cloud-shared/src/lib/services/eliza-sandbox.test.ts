import { describe, expect, test } from "bun:test";

import { resolveSandboxContainerLaunchConfig } from "./sandbox-container-launch-config";

describe("resolveSandboxContainerLaunchConfig", () => {
  test("maps stored waifu container hints to sandbox provider launch config", () => {
    expect(
      resolveSandboxContainerLaunchConfig({
        container: {
          projectName: "waifu-smoke-agent",
          port: 3000,
          cpu: 512,
          memory: 1024,
          desiredCount: 1,
          architecture: "arm64",
          healthCheckPath: "/api/health",
        },
      }),
    ).toEqual({
      projectName: "waifu-smoke-agent",
      port: 3000,
      cpu: 512,
      memoryMb: 1024,
      desiredCount: 1,
      architecture: "arm64",
      healthCheckPath: "/api/health",
    });
  });

  test("ignores invalid or absent container hints", () => {
    expect(
      resolveSandboxContainerLaunchConfig({
        container: {
          projectName: "",
          port: 0,
          cpu: -1,
          memory: Number.NaN,
          desiredCount: 1.5,
          architecture: "riscv64",
          healthCheckPath: "",
        },
      }),
    ).toBeUndefined();
    expect(resolveSandboxContainerLaunchConfig({})).toBeUndefined();
  });
});
